#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install
fi

if [ ! -f "dist/index.html" ]; then
  echo "Building widget..."
  npm run build
fi

log_dir="$HOME/.codex/quota-pet-widget"
mkdir -p "$log_dir"
nohup npm start > "$log_dir/launch.log" 2>&1 &

echo "Codex quota widget started. You can close this terminal window."
