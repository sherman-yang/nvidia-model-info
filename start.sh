#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js is not installed or not in PATH."
  echo "Please install Node.js 18+ first."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "Error: npm is not installed or not in PATH."
  exit 1
fi

if [[ -z "${NVIDIA_API_KEY:-}" ]]; then
  echo "Error: environment variable NVIDIA_API_KEY is not set."
  echo "Please set it in your shell before running:"
  echo '  export NVIDIA_API_KEY="your_nvidia_api_key"'
  exit 1
fi

echo "Installing dependencies..."
npm install

# Define port (default to 4920 if not set)
TARGET_PORT="${PORT:-4920}"

echo "Checking if port $TARGET_PORT is already in use..."
PIDS=$(lsof -Pi :$TARGET_PORT -sTCP:LISTEN -t || true)

if [ -n "$PIDS" ]; then
  for PID in $PIDS; do
    # Get the command name and arguments of the process
    CMD_INFO=$(ps -p $PID -o command= || true)
    
    # Check if it's our node process running nvidia-model-server-info.js in any capacity
    if [[ "$CMD_INFO" == *"node"* && "$CMD_INFO" == *"nvidia-model-server-info.js"* ]]; then
      echo "Found our previous nvidia-model-info server (PID: $PID) hanging on port $TARGET_PORT."
      echo "Safely terminating it..."
      kill -9 $PID
      sleep 1
    else
      echo "WARNING: Port $TARGET_PORT is currently occupied by an UNKNOWN process (PID $PID):"
      echo "  -> $CMD_INFO"
      echo "Aborting to prevent accidentally killing another application's service."
      echo "Please free port $TARGET_PORT manually or set a different PORT environment variable."
      exit 1
    fi
  done
fi

echo "Starting nvidia-model-info..."
exec npm start
