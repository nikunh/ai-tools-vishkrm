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

echo "GitHub CLI installed. Note: To install GitHub Copilot CLI extension, run:"
echo "  gh auth login"
echo "  gh extension install github/gh-copilot"

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


echo "AI tools installation completed successfully"
echo "Available tools: github copilot (gh copilot), claude, ollama"# Auto-trigger build Tue Sep 23 20:02:56 BST 2025
