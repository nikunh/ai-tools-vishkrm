#!/bin/bash
set -e

# Set DEBIAN_FRONTEND to noninteractive to prevent prompts
export DEBIAN_FRONTEND=noninteractive

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

# Install fabric (AI-powered command line tool)
if ! command -v fabric &> /dev/null; then
    echo "Installing fabric..."
    # Install via Go (fabric has migrated from Python to Go)
    go install github.com/danielmiessler/fabric@latest
fi

# Install ollama (local LLM runner)
if ! command -v ollama &> /dev/null; then
    echo "Installing ollama..."
    curl -fsSL https://ollama.ai/install.sh | sh
fi

# Install chatblade (ChatGPT CLI)
if ! command -v chatblade &> /dev/null; then
    echo "Installing chatblade..."
    pip3 install chatblade
fi

echo "AI tools installation completed successfully"
echo "Available tools: fabric, ollama, chatblade"