#!/bin/bash
set -e

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

# Install legacy Node.js GitHub Copilot CLI (deprecated but still useful)
if ! command -v github-copilot-cli &> /dev/null; then
    echo "Installing legacy GitHub Copilot CLI (Node.js version)..."
    npm install -g @githubnext/github-copilot-cli || echo "Legacy Copilot CLI installation failed (optional)"
fi

# Install ollama (local LLM runner)
if ! command -v ollama &> /dev/null; then
    echo "Installing ollama..."
    curl -fsSL https://ollama.ai/install.sh | sh
fi

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
    npm install -g @opencode-ai/opencode || echo "OpenCode AI installation failed (optional)"
    echo "Verifying OpenCode installation..."
    opencode --version || echo "OpenCode verification failed"
fi


echo "AI tools installation completed successfully"
echo "Available tools:"
echo "  - GitHub Copilot CLI (gh copilot) - AI pair programmer (official)"
echo "  - GitHub Copilot CLI Legacy (github-copilot-cli) - Node.js version"
echo "  - Claude Code (claude) - Anthropic's AI assistant"
echo "  - OpenCode AI (opencode) - AI-powered code completion and chat"
echo "  - Ollama (ollama) - Local LLM runner"# Auto-trigger build Wed Sep 25 14:42:00 GMT 2024
