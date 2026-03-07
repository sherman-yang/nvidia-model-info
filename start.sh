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

if [[ -z "${Sherman_NVDA_test:-}" ]]; then
  echo "Error: environment variable Sherman_NVDA_test is not set."
  echo "Please set it in your shell before running:"
  echo '  export Sherman_NVDA_test="your_nvidia_api_key"'
  exit 1
fi

echo "Installing dependencies..."
npm install

echo "Starting nvidia-model-info..."
exec npm start
