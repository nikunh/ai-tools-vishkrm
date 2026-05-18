#!/usr/bin/env zsh
set -e

# Logging mechanism for debugging
LOG_FILE="/tmp/ai-tools-install.log"
log_debug() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') [DEBUG] $*" >> "$LOG_FILE"
}

# Initialize logging
log_debug "=== AI-TOOLS INSTALL STARTED ==="
log_debug "Script path: $0"
log_debug "PWD: $(pwd)"
log_debug "Environment: USER=$USER HOME=$HOME"

# Set DEBIAN_FRONTEND to noninteractive to prevent prompts
export DEBIAN_FRONTEND=noninteractive
# Token fix test - trigger automation Mon Sep 23 22:12:00 BST 2025

# Function to get system architecture
get_architecture() {
    local arch="$(uname -m)"
    case "$arch" in
        x86_64|amd64) echo "amd64" ;;
        aarch64|arm64) echo "arm64" ;;
        *) echo "Unsupported architecture: $arch" >&2; exit 1 ;;
    esac
}

echo "Installing AI development tools..."

# Install GitHub Copilot CLI
if ! command -v gh &> /dev/null; then
    echo "Installing GitHub CLI (required for Copilot)..."
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null
    apt-get update
    apt-get install -y gh
fi

echo "GitHub CLI installed."

# Install GitHub Copilot CLI extension (current official version)
echo "Installing GitHub Copilot CLI extension..."
gh extension install github/gh-copilot --force 2>/dev/null || {
    echo "Note: GitHub Copilot CLI will be available after authentication"
    echo "To complete setup, run: gh auth login && gh extension install github/gh-copilot"
}

# Install official GitHub Copilot CLI (standalone terminal tool)
if ! command -v copilot &> /dev/null; then
    echo "Installing GitHub Copilot CLI (standalone)..."
    npm install -g @github/copilot || echo "GitHub Copilot CLI installation failed (optional)"
fi

# Install ollama (local LLM runner)
# DISABLED 2026-05-13 per D9 phase 1 (image slimming). Saves ~1.7 GB
# (ollama bundles CUDA/ROCm runtime libs regardless of GPU presence).
# Re-enable by uncommenting the block below if a local-LLM workflow is needed,
# or prefer runtime install via shellinator-enhance (D3 tier).
# if ! command -v ollama &> /dev/null; then
#     echo "Installing ollama..."
#     apt-get update && apt-get install -y --no-install-recommends zstd
#     curl -fsSL https://ollama.ai/install.sh | sh
# fi

# Install Claude Code globally
if ! command -v claude &> /dev/null; then
    echo "Installing Claude Code CLI..."
    npm install -g @anthropic-ai/claude-code
    echo "Verifying Claude Code installation..."
    claude --version || echo "Claude Code installation verification failed"
fi

# Install OpenCode AI CLI
if ! command -v opencode &> /dev/null; then
    echo "Installing OpenCode AI CLI..."
    npm install -g opencode-ai || echo "OpenCode AI installation failed (optional)"
    echo "Verifying OpenCode installation..."
    opencode --version || echo "OpenCode verification failed"
fi


echo "AI tools installation completed successfully"
echo "Available tools:"
echo "  - GitHub Copilot CLI Extension (gh copilot) - AI pair programmer via GitHub CLI"
echo "  - GitHub Copilot CLI Standalone (copilot) - Terminal-native AI coding agent"
echo "  - Claude Code (claude) - Anthropic's AI assistant"
echo "  - OpenCode AI (opencode) - AI-powered code completion and chat"
# echo "  - Ollama (ollama) - Local LLM runner"  # disabled per D9 phase 1

# ===========================================================================
# Phase 4: vishkrm-channel install + claude wrapper + zshrc fragment
# (Inline I15 fix — never trust _REMOTE_USER=root)
# ===========================================================================

# Resolve runtime user (refuses _REMOTE_USER=root, prefers vishkrm)
USERNAME="${USERNAME:-${_REMOTE_USER:-}}"
if [ -z "$USERNAME" ] || [ "$USERNAME" = "root" ]; then
    if getent passwd vishkrm >/dev/null 2>&1; then
        USERNAME=vishkrm
    else
        USERNAME=$(getent passwd | awk -F: '$3>=1000 && $1!="nobody" {print $1; exit}')
    fi
fi
USER_HOME="$(getent passwd "$USERNAME" 2>/dev/null | cut -d: -f6)"
[ -z "$USER_HOME" ] && USER_HOME="/home/${USERNAME}"
USER_GROUP="$(id -gn "$USERNAME" 2>/dev/null || echo users)"
log_debug "Phase 4: resolved USERNAME=$USERNAME USER_HOME=$USER_HOME USER_GROUP=$USER_GROUP"

# Install vishkrm-channel to /opt (code lives in container, state on NAS)
SCRIPT_DIR="$(dirname "$0")"
CHANNEL_SRC="$SCRIPT_DIR/vishkrm-channel"
CHANNEL_DST="/opt/vishkrm-channel"
if [ -d "$CHANNEL_SRC" ] && [ -f "$CHANNEL_SRC/package.json" ]; then
    echo "Installing vishkrm-channel to $CHANNEL_DST..."
    mkdir -p "$CHANNEL_DST"
    cp -r "$CHANNEL_SRC/." "$CHANNEL_DST/"
    chmod +x "$CHANNEL_DST/bin.sh" "$CHANNEL_DST/vishkrm-channel.ts" 2>/dev/null || true
    if command -v npm >/dev/null 2>&1; then
        (cd "$CHANNEL_DST" && npm install --no-audit --no-fund --silent 2>&1) || echo "Warning: vishkrm-channel npm install failed (channel will be unavailable; wrapper will pass through to vanilla claude)"
        # Install globally so /usr/local/bin/vishkrm-channel exists for the --dangerously-load-development-channels server:vishkrm-channel flag
        (cd "$CHANNEL_DST" && npm install -g . --silent 2>&1) || echo "Warning: vishkrm-channel global install failed"
    else
        echo "Warning: npm not found — vishkrm-channel installation skipped"
    fi
else
    log_debug "vishkrm-channel/ not found at $CHANNEL_SRC — skipping channel install"
fi

# Wrapper at $USER_HOME/.local/bin/claude — PATH-ordered above /usr/local/bin/claude
# Auto-loads vishkrm-channel if available + CLAUDE_CHANNELS is set; passthrough otherwise.
install -d -m 0755 -o "$USERNAME" -g "$USER_GROUP" "$USER_HOME/.local/bin"
cat > "$USER_HOME/.local/bin/claude" << 'CLAUDE_WRAPPER_EOF'
#!/bin/bash
# vishkrm-claude-channel wrapper (Phase 4) — auto-loads MCP channel if available
if [ -d "/opt/vishkrm-channel/node_modules" ] && [ -n "${CLAUDE_CHANNELS:-}" ]; then
    exec /usr/local/bin/claude --dangerously-load-development-channels "$CLAUDE_CHANNELS" "$@"
fi
exec /usr/local/bin/claude "$@"
CLAUDE_WRAPPER_EOF
chmod 0755 "$USER_HOME/.local/bin/claude"
chown "$USERNAME:$USER_GROUP" "$USER_HOME/.local/bin/claude"
echo "✅ claude wrapper installed at $USER_HOME/.local/bin/claude"

# Zshrc fragment — sets CLAUDE_CHANNELS for the wrapper. Self-healing.
FRAG_DIR="$USER_HOME/.ohmyzsh_source_load_scripts"
FRAG="$FRAG_DIR/.vishkrm-channel.zshrc"
install -d -m 0755 -o "$USERNAME" -g "$USER_GROUP" "$FRAG_DIR"
cat > "$FRAG" << 'FRAG_EOF'
# vishkrm-channel fragment (Phase 4) — self-heals: removes itself if wrapper missing
if [ ! -x "$HOME/.local/bin/claude" ]; then
    rm -f "$HOME/.ohmyzsh_source_load_scripts/.vishkrm-channel.zshrc"
    return 0 2>/dev/null || true
fi
export CLAUDE_CHANNELS="server:vishkrm-channel"
FRAG_EOF
chown "$USERNAME:$USER_GROUP" "$FRAG"
echo "✅ vishkrm-channel zshrc fragment installed at $FRAG"

log_debug "=== AI-TOOLS INSTALL COMPLETED ==="
# Auto-trigger build Wed Sep 25 14:42:00 GMT 2024
