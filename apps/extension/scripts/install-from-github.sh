#!/usr/bin/env bash
#
# install.sh — Download latest .vsix from GitHub Releases and install into VS Code
#
#   curl -fsSL https://raw.githubusercontent.com/ThePlenkov/vscode-model-provider/main/scripts/install.sh | bash
#   # or
#   ./scripts/install-from-github.sh
#
# TEMPORARY TESTING SOLUTION — until published to VS Code Marketplace / Open VSX
#
set -euo pipefail

REPO="ThePlenkov/vscode-model-provider"
EXT="vscode-model-provider"
VSIX="/tmp/${EXT}-latest.vsix"

echo "[vscode-model-provider] Fetching latest release…"

# Get the latest version tag
TAG=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
  -H "Accept: application/vnd.github+json" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['tag_name'])" 2>/dev/null || echo "")

if [[ -z "$TAG" ]]; then
  echo "ERROR: Could not determine latest release tag." >&2
  echo "Make sure the extension has been published to GitHub Releases." >&2
  exit 1
fi

VSIX_URL="https://github.com/${REPO}/releases/download/${TAG}/${EXT}-latest.vsix"
echo "  Version: ${TAG}"
echo "  URL:     ${VSIX_URL}"

# Download the .vsix
echo "Downloading…"
curl -fsSL "$VSIX_URL" -o "$VSIX"

# Verify it's a zip
if ! file "$VSIX" | grep -q "Zip"; then
  echo "ERROR: Downloaded file is not a valid .vsix" >&2
  rm -f "$VSIX"
  exit 1
fi

# Install into VS Code
echo "Installing into VS Code…"
code --install-extension "$VSIX" --force

# Cleanup
rm -f "$VSIX"

echo ""
echo "✓ ACP Model Provider installed (${TAG})"
echo "  Restart VS Code to activate."
echo ""
echo "NOTE: This extension was installed from GitHub Releases (pre-release)."
echo "  For production use, install from VS Code Marketplace once published."
