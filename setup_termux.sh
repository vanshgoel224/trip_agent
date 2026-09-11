#!/data/data/com.termux/files/usr/bin/bash
# Run inside Termux (install Termux from F-Droid, NOT Play Store — Play version is outdated/broken for this).
set -e

echo "[1/5] Updating Termux packages..."
pkg update -y && pkg upgrade -y

echo "[2/5] Installing dependencies..."
pkg install -y python git curl proot-distro

echo "[3/5] Installing Ollama (via proot Linux distro — Ollama has no native Android binary)..."
proot-distro install ubuntu || true
proot-distro login ubuntu -- bash -c "
  curl -fsSL https://ollama.com/install.sh | sh
"

echo "[4/5] Pulling model (qwen2.5:3b-instruct, ~2GB, tool-calling capable)..."
proot-distro login ubuntu -- bash -c "
  (ollama serve &) && sleep 5 && ollama pull qwen2.5:3b-instruct
"

echo "[5/5] Installing Python deps for the agent..."
pip install requests

echo ""
echo "Setup done. To run:"
echo "  1. In one Termux session: proot-distro login ubuntu -- ollama serve"
echo "  2. In another: cd trip_agent && python agent.py"
echo ""
echo "RAM note: on 8GB phones, close background apps before running — the 3B model"
echo "needs ~2.5-3GB free RAM. If it OOMs, switch MODEL in agent.py to a 1.5B variant."
