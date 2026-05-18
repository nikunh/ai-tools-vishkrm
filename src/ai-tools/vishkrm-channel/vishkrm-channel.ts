#!/usr/bin/env -S npx tsx
/**
 * vishkrm-channel.ts — Inter-session message channel for Vishkrm Claude sessions
 *
 * Each Claude Code session runs its own instance. Sessions communicate by
 * POSTing to each other's HTTP endpoints. MCP delivers messages natively
 * into Claude Code without tmux injection.
 *
 * Session name discovery (in order):
 *   1. {cwd}/.vishkrm-session-name   (written by /register-session)
 *   2. <channel>/session-registry.json   (matched by working_dir)
 *   3. basename(cwd)                  (fallback)
 *
 * Port allocation:
 *   - Reads registry/ to find reserved ports
 *   - Picks lowest free port in range 10000-11000
 *   - Reserves it, tries to bind
 *   - If bind fails: removes reservation, retries from registry
 *
 * Usage:
 *   claude --dangerously-load-development-channels server:vishkrm-channel
 *
 * State location:
 *   ~/synnas_home/babaji/projects/.vishkrm/channel/
 *   (registry/, replies/, schedules/, access.json, session-registry.json,
 *    health-status.json — runtime state, shared across machines via NAS)
 *
 * Code location (this file):
 *   /opt/vishkrm-channel/  (container-local; installed by ai-tools feature)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { readFileSync, writeFileSync, existsSync, mkdirSync, watch, unlinkSync, statSync } from 'fs'
import { readdirSync } from 'fs'
import { join, basename } from 'path'
import { homedir } from 'os'
import { createServer as createNetServer } from 'net'
import { createServer as createHttpServer, IncomingMessage, ServerResponse } from 'http'

// ---------------------------------------------------------------------------
// Paths & constants
// ---------------------------------------------------------------------------

// CHANNEL_DIR resolves at runtime. Only the suffix after ~/synnas_home/ is
// portable; the home prefix is changeable per personality/host.
const CHANNEL_DIR  = join(homedir(), 'synnas_home', 'babaji', 'projects', '.vishkrm', 'channel')
const REGISTRY_DIR = join(CHANNEL_DIR, 'registry')
const REPLIES_DIR  = join(CHANNEL_DIR, 'replies')
const ACCESS_FILE  = join(CHANNEL_DIR, 'access.json')
const SES_REGISTRY = join(CHANNEL_DIR, 'session-registry.json')
const NAME_FILE     = join(process.cwd(), '.vishkrm-session-name')
const SCHEDULE_DIR  = join(CHANNEL_DIR, 'schedules')
const HEALTH_STATUS_FILE = join(CHANNEL_DIR, 'health-status.json')

const PORT_MIN          = 10000
const PORT_MAX          = 11000
const MAX_PORT_RETRIES  = 5
const HEARTBEAT_MS      = 30_000
const STALE_MS          = parseInt(process.env.VISHKRM_STALE_THRESHOLD_MS || '120000', 10)
const TTL_MS            = 90_000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RegistryEntry {
  port:      number
  pid:       number
  status:    'reserving' | 'active'
  started:   string
  last_seen: string
}

interface SessionRegistry {
  [name: string]: { working_dir: string; [k: string]: unknown }
}

interface AccessConfig {
  allowlist: string[]
}

interface PendingMessage {
  from:     string
  target:   string
  received: string
}

interface Schedule {
  id:       string
  task:     string
  every:    string
  status:   'active' | 'paused' | 'disabled'
  created:  string
  last_run: string | null
  next_run: string | null
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(msg: string): void {
  process.stderr.write(`[vishkrm-channel] ${msg}\n`)
}

// ---------------------------------------------------------------------------
// Session name discovery
// ---------------------------------------------------------------------------

function discoverName(): string {
  if (existsSync(NAME_FILE)) {
    const name = readFileSync(NAME_FILE, 'utf-8').trim()
    if (name) return name
  }

  if (existsSync(SES_REGISTRY)) {
    try {
      const reg: SessionRegistry = JSON.parse(readFileSync(SES_REGISTRY, 'utf-8'))
      const cwd = process.cwd()
      for (const [name, entry] of Object.entries(reg)) {
        if (entry.working_dir === cwd) return name
      }
    } catch { /* corrupt registry, skip */ }
  }

  return basename(process.cwd())
}

// ---------------------------------------------------------------------------
// Registry helpers
// ---------------------------------------------------------------------------

function writeEntry(name: string, entry: RegistryEntry): void {
  writeFileSync(join(REGISTRY_DIR, `${name}.json`), JSON.stringify(entry, null, 2))
}

function removeEntry(name: string): void {
  const f = join(REGISTRY_DIR, `${name}.json`)
  try { if (existsSync(f)) unlinkSync(f) } catch { /* ignore */ }
}

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

function readEntry(name: string): RegistryEntry | null {
  const f = join(REGISTRY_DIR, `${name}.json`)
  if (!existsSync(f)) return null
  try {
    const e: RegistryEntry = JSON.parse(readFileSync(f, 'utf-8'))
    const age = Date.now() - new Date(e.last_seen).getTime()
    if (age > STALE_MS || !isPidAlive(e.pid)) return null
    return e
  } catch { return null }
}

function getPort(name: string): number | null {
  return readEntry(name)?.port ?? null
}

function reservedPorts(excludeName: string): Set<number> {
  const ports = new Set<number>()
  try {
    for (const file of readdirSync(REGISTRY_DIR)) {
      if (!file.endsWith('.json')) continue
      const name = file.replace('.json', '')
      if (name === excludeName) continue
      const e = readEntry(name)
      if (e) ports.add(e.port)
    }
  } catch { /* registry dir empty or unreadable */ }
  return ports
}

// ---------------------------------------------------------------------------
// Port allocation
// ---------------------------------------------------------------------------

function tryBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createNetServer()
    s.once('error', () => resolve(false))
    s.once('listening', () => s.close(() => resolve(true)))
    s.listen(port, '127.0.0.1')
  })
}

async function allocatePort(name: string): Promise<number> {
  const osBound = new Set<number>()

  for (let attempt = 0; attempt < MAX_PORT_RETRIES; attempt++) {
    const used = new Set([...reservedPorts(name), ...osBound])

    let target: number | null = null
    for (let p = PORT_MIN; p <= PORT_MAX; p++) {
      if (!used.has(p)) { target = p; break }
    }
    if (target === null) throw new Error('No free ports in range 10000-11000')

    writeEntry(name, {
      port: target, pid: process.pid,
      status: 'reserving',
      started: new Date().toISOString(),
      last_seen: new Date().toISOString(),
    })

    if (await tryBind(target)) return target

    osBound.add(target)
    const existing = readEntry(name)
    if (existing && existing.pid === process.pid) removeEntry(name)
    log(`Port ${target} bind failed, retrying (attempt ${attempt + 1}/${MAX_PORT_RETRIES})`)
  }
  throw new Error(`Could not allocate port after ${MAX_PORT_RETRIES} attempts`)
}

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

function isAllowed(from: string): boolean {
  try {
    const a: AccessConfig = JSON.parse(readFileSync(ACCESS_FILE, 'utf-8'))
    return a.allowlist.includes(from)
  } catch { return false }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

mkdirSync(CHANNEL_DIR,   { recursive: true })
mkdirSync(REGISTRY_DIR,  { recursive: true })
mkdirSync(REPLIES_DIR,   { recursive: true })
mkdirSync(SCHEDULE_DIR,  { recursive: true })

let sessionName = discoverName()
let myPort      = await allocatePort(sessionName)

log(`Starting as '${sessionName}' on port ${myPort}`)

const pendingMessages = new Map<string, PendingMessage>()

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const mcp = new Server(
  { name: 'vishkrm-channel', version: '1.0.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions: `
You are receiving inter-session messages via the vishkrm-channel.
Your session name is: ${sessionName}

Inbound messages arrive as:
<channel source="vishkrm-channel" type="message" from="<sender>" id="<id>">
the question here
</channel>

When you receive a message:
1. Answer it fully using your context and tools
2. Call the reply tool: reply({ id: "<id>", text: "<your answer>" })
3. Return to your work

Inbound replies (responses to your own /ask) arrive as:
<channel source="vishkrm-channel" type="reply" from="<sender>" id="<id>">
the answer here
</channel>

When you receive a reply, display it clearly to the user.
    `.trim(),
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'reply',
    description: 'Send your answer back to the session that messaged you',
    inputSchema: {
      type: 'object',
      properties: {
        id:   { type: 'string', description: 'Correlation ID from the inbound <channel> tag' },
        text: { type: 'string', description: 'Your complete response' },
      },
      required: ['id', 'text'],
    },
  }],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== 'reply') throw new Error(`unknown tool: ${req.params.name}`)

  const { id, text } = req.params.arguments as { id: string; text: string }
  const pending = pendingMessages.get(id)

  if (!pending) {
    return { content: [{ type: 'text', text: `Warning: no pending message with id ${id}` }] }
  }

  const senderPort = getPort(pending.from)
  if (!senderPort) {
    pendingMessages.delete(id)
    return { content: [{ type: 'text', text: `${pending.from} is offline — reply dropped` }] }
  }

  try {
    const res = await fetch(`http://127.0.0.1:${senderPort}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, from: sessionName, text }),
    })
    pendingMessages.delete(id)
    return {
      content: [{ type: 'text', text: res.ok ? `sent to ${pending.from}` : `send failed (${res.status})` }],
    }
  } catch {
    pendingMessages.delete(id)
    return { content: [{ type: 'text', text: `Could not reach ${pending.from} — reply dropped` }] }
  }
})

await mcp.connect(new StdioServerTransport())

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString() })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${myPort}`)

  if (url.pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ session: sessionName, port: myPort, pid: process.pid, status: 'ok' }))
    return
  }

  if (url.pathname === '/message' && req.method === 'POST') {
    try {
      const body = await readBody(req)
      const msg = JSON.parse(body) as { from: string; target?: string; id: string; text: string }

      pendingMessages.set(msg.id, { from: msg.from, target: sessionName, received: new Date().toISOString() })
      setTimeout(() => pendingMessages.delete(msg.id), TTL_MS)

      await mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: msg.text,
          meta: { type: 'message', from: msg.from, id: msg.id },
        },
      })

      res.writeHead(200); res.end('ok')
    } catch {
      res.writeHead(400); res.end('Bad request')
    }
    return
  }

  if (url.pathname === '/reply' && req.method === 'POST') {
    try {
      const body = await readBody(req)
      const msg = JSON.parse(body) as { id: string; from: string; text: string }

      writeFileSync(
        join(REPLIES_DIR, `${msg.id}.json`),
        JSON.stringify({ id: msg.id, from: msg.from, text: msg.text, received: new Date().toISOString() }, null, 2),
      )

      await mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: msg.text,
          meta: { type: 'reply', from: msg.from, id: msg.id },
        },
      })

      res.writeHead(200); res.end('ok')
    } catch {
      res.writeHead(400); res.end('Bad request')
    }
    return
  }

  const replyPoll = url.pathname.match(/^\/reply\/([a-z0-9]+)$/)
  if (replyPoll && req.method === 'GET') {
    const replyFile = join(REPLIES_DIR, `${replyPoll[1]}.json`)
    if (existsSync(replyFile)) {
      const data = readFileSync(replyFile, 'utf-8')
      unlinkSync(replyFile)
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(data)
    } else {
      res.writeHead(404); res.end('not found')
    }
    return
  }

  if (url.pathname === '/messages' && req.method === 'GET') {
    const messages: any[] = []
    for (const [id, meta] of pendingMessages) {
      if (meta.target === sessionName) {
        messages.push({ id, from: meta.from })
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(messages))
    return
  }

  res.writeHead(404); res.end('Not found')
})

httpServer.listen(myPort, '127.0.0.1', () => {
  writeEntry(sessionName, {
    port: myPort, pid: process.pid,
    status: 'active',
    started: new Date().toISOString(),
    last_seen: new Date().toISOString(),
  })
  log(`Listening on localhost:${myPort}`)
})

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

const heartbeat = setInterval(() => {
  try {
    const f = join(REGISTRY_DIR, `${sessionName}.json`)
    if (!existsSync(f)) return
    const e: RegistryEntry = JSON.parse(readFileSync(f, 'utf-8'))
    e.last_seen = new Date().toISOString()
    writeFileSync(f, JSON.stringify(e, null, 2))
  } catch { /* ignore */ }
}, HEARTBEAT_MS)

// ---------------------------------------------------------------------------
// postToSelf — inject a channel event into this session
// ---------------------------------------------------------------------------

async function postToSelf(text: string): Promise<void> {
  const id = Math.random().toString(36).slice(2, 10)
  pendingMessages.set(id, { from: sessionName, target: sessionName, received: new Date().toISOString() })
  setTimeout(() => pendingMessages.delete(id), TTL_MS)
  try {
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content: text,
        meta: { type: 'message', from: sessionName, id },
      },
    })
  } catch {
    pendingMessages.delete(id)
  }
}

// ---------------------------------------------------------------------------
// findJsonl — locate this session's active JSONL conversation file
// Claude CLI encodes CWD as: replace all '/' with '-'
// ---------------------------------------------------------------------------

function findJsonl(): string | null {
  try {
    const encoded = process.cwd().replace(/\//g, '-')
    const projectDir = join(homedir(), '.claude', 'projects', encoded)
    if (!existsSync(projectDir)) return null
    const files = readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => join(projectDir, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    return files[0] ?? null
  } catch { return null }
}

function isSessionActive(thresholdMs: number): boolean {
  const jsonl = findJsonl()
  if (!jsonl) return false
  return (Date.now() - statSync(jsonl).mtimeMs) < thresholdMs
}

// ---------------------------------------------------------------------------
// Schedule helpers
// ---------------------------------------------------------------------------

function parseIntervalMs(every: string): number {
  if (every === 'morning' || every === 'daily') return 24 * 60 * 60 * 1000
  if (every === 'weekly') return 7 * 24 * 60 * 60 * 1000
  if (every === 'hourly') return 60 * 60 * 1000
  const min = every.match(/^(\d+)min$/)
  if (min) return parseInt(min[1]) * 60 * 1000
  const hr = every.match(/^(\d+)h$/)
  if (hr) return parseInt(hr[1]) * 60 * 60 * 1000
  return 24 * 60 * 60 * 1000
}

function nextRunAfter(every: string, from: Date = new Date()): Date {
  if (every === 'morning' || every === 'daily') {
    const next = new Date(from)
    next.setHours(9, 0, 0, 0)
    if (next <= from) next.setDate(next.getDate() + 1)
    return next
  }
  return new Date(from.getTime() + parseIntervalMs(every))
}

// ---------------------------------------------------------------------------
// Schedule check — fires due schedules every minute
// ---------------------------------------------------------------------------

const SCHEDULE_CHECK_MS = 60 * 1000

const scheduleCheck = setInterval(async () => {
  try {
    const scheduleFile = join(SCHEDULE_DIR, `${sessionName}.json`)
    if (!existsSync(scheduleFile)) return

    const schedules: Schedule[] = JSON.parse(readFileSync(scheduleFile, 'utf-8'))
    const now = new Date()
    let changed = false

    for (const sched of schedules) {
      if (sched.status !== 'active') continue
      if (!sched.next_run || new Date(sched.next_run) <= now) {
        const historyFile = join(SCHEDULE_DIR, `${sessionName}-history.json`)
        await postToSelf(
          `Schedule [${sched.id}] due: ${sched.task}\n\n` +
          `Run this check now using whatever tools are appropriate (web search, kubectl, AWS CLI — whatever fits the task).\n` +
          `When done, append your finding to ${historyFile} as a JSON entry:\n` +
          `{ "schedule_id": "${sched.id}", "ran_at": "${now.toISOString()}", "result": "<your finding in 1-2 sentences>" }\n` +
          `If the file does not exist, create it as a JSON array containing this entry.\n` +
          `Do this before returning to other work.`
        )
        sched.last_run = now.toISOString()
        sched.next_run = nextRunAfter(sched.every, now).toISOString()
        changed = true
        log(`Schedule fired: [${sched.id}] "${sched.task}" for ${sessionName}`)
      }
    }

    if (changed) writeFileSync(scheduleFile, JSON.stringify(schedules, null, 2))
  } catch { /* ignore */ }
}, SCHEDULE_CHECK_MS)

// ---------------------------------------------------------------------------
// Health pings — check all sessions every 5 min, write health-status.json
// ---------------------------------------------------------------------------

const HEALTH_PING_MS = 5 * 60 * 1000

const healthPing = setInterval(async () => {
  const status: Record<string, { port: number; alive: boolean; checked: string }> = {}
  try {
    for (const file of readdirSync(REGISTRY_DIR)) {
      if (!file.endsWith('.json')) continue
      const name = file.replace('.json', '')
      const entry = readEntry(name)
      if (!entry) {
        status[name] = { port: 0, alive: false, checked: new Date().toISOString() }
        continue
      }
      try {
        const r = await fetch(`http://127.0.0.1:${entry.port}/health`, {
          signal: AbortSignal.timeout(2000),
        })
        status[name] = { port: entry.port, alive: r.ok, checked: new Date().toISOString() }
      } catch {
        status[name] = { port: entry.port, alive: false, checked: new Date().toISOString() }
      }
    }
    writeFileSync(HEALTH_STATUS_FILE, JSON.stringify(status, null, 2))
  } catch { /* ignore */ }
}, HEALTH_PING_MS)

// ---------------------------------------------------------------------------
// Registry cleanup — removes stale sessions from both registries
// ---------------------------------------------------------------------------

const REGISTRY_CLEANUP_MS = 5 * 60 * 1000

const registryCleanup = setInterval(async () => {
  try {
    if (!existsSync(SES_REGISTRY)) return

    const sessions: SessionRegistry = JSON.parse(readFileSync(SES_REGISTRY, 'utf-8'))
    let changed = false

    let healthStatus: Record<string, { alive: boolean; checked: string }> = {}
    if (existsSync(HEALTH_STATUS_FILE)) {
      try {
        healthStatus = JSON.parse(readFileSync(HEALTH_STATUS_FILE, 'utf-8'))
      } catch { /* ignore */ }
    }

    const now = new Date()
    const STALE_NO_HEALTH_MS = 10 * 60 * 1000

    for (const name of Object.keys(sessions)) {
      const health = healthStatus[name]
      const entry = sessions[name]

      let isDead = false
      let reason = ''

      if (health && health.alive === false) {
        isDead = true
        reason = 'health check failed'
      }
      else if (!health && entry.last_active) {
        try {
          const lastActive = new Date(entry.last_active as string)
          const ageMs = now.getTime() - lastActive.getTime()
          if (ageMs > STALE_NO_HEALTH_MS) {
            isDead = true
            reason = `no health check (age: ${Math.round(ageMs / 1000)}s)`
          }
        } catch { /* ignore date parse errors */ }
      }

      if (isDead) {
        delete sessions[name]
        const portFile = join(REGISTRY_DIR, `${name}.json`)
        if (existsSync(portFile)) {
          try { unlinkSync(portFile) } catch { /* ignore */ }
        }
        changed = true
        log(`Cleaned dead session '${name}' (${reason})`)
      }
    }

    if (changed) {
      writeFileSync(SES_REGISTRY, JSON.stringify(sessions, null, 2))
    }
  } catch { /* ignore */ }
}, REGISTRY_CLEANUP_MS)

// ---------------------------------------------------------------------------
// Watch .vishkrm-session-name for renames (/register-session writes this)
// ---------------------------------------------------------------------------

try {
  watch(process.cwd(), { persistent: false }, (_event, filename) => {
    if (filename !== '.vishkrm-session-name') return
    try {
      if (!existsSync(NAME_FILE)) return
      const newName = readFileSync(NAME_FILE, 'utf-8').trim()
      if (!newName || newName === sessionName) return

      log(`Renamed: '${sessionName}' → '${newName}'`)
      removeEntry(sessionName)
      sessionName = newName
      writeEntry(sessionName, {
        port: myPort, pid: process.pid,
        status: 'active',
        started: new Date().toISOString(),
        last_seen: new Date().toISOString(),
      })
      log(`Re-registered as '${sessionName}' on port ${myPort}`)
    } catch { /* ignore */ }
  })
} catch { /* cwd not watchable — skip */ }

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function cleanup(): Promise<void> {
  log(`Shutting down '${sessionName}'`)
  clearInterval(heartbeat)
  clearInterval(scheduleCheck)
  clearInterval(healthPing)
  clearInterval(registryCleanup)
  httpServer.close()
  removeEntry(sessionName)
  process.exit(0)
}

process.on('SIGTERM', cleanup)
process.on('SIGINT',  cleanup)
process.on('SIGHUP',  cleanup)

log(`Ready — session='${sessionName}' port=${myPort}`)
