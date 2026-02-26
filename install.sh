#!/bin/bash
set -euo pipefail

# Chrome Profile Switcher — Install Script
# Sets up the native messaging host so the Chrome extension can communicate
# with the Python profile switcher.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_DIR="$SCRIPT_DIR/native-host"
HOST_SCRIPT="$HOST_DIR/profile_switcher_host.py"
HOST_NAME="dev.garethj.chrome_profile_switcher"
NMH_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
MANIFEST_PATH="$NMH_DIR/$HOST_NAME.json"

# Install location — Chrome's native messaging can fail with spaces in the
# host path, so we copy the script to a safe location.
INSTALL_DIR="$HOME/.local/bin"
INSTALLED_HOST="$INSTALL_DIR/chrome_profile_switcher_host.py"

echo "Chrome Profile Switcher — Installer"
echo "===================================="
echo

# 1. Find Python
PYTHON_PATH=""
if command -v pyenv &>/dev/null; then
  PYTHON_PATH="$(pyenv which python3 2>/dev/null || true)"
fi
if [[ -z "$PYTHON_PATH" ]]; then
  PYTHON_PATH="$(which python3 2>/dev/null || true)"
fi
if [[ -z "$PYTHON_PATH" ]]; then
  echo "ERROR: python3 not found. Install Python 3 and try again."
  exit 1
fi
echo "Using Python: $PYTHON_PATH"

# 2. Install host script to a path without spaces (Chrome native messaging
#    cannot handle spaces in the host path on macOS).
mkdir -p "$INSTALL_DIR"

# Set the absolute python shebang so Chrome can run the script directly
sed "1s|^#!.*|#!${PYTHON_PATH}|" "$HOST_SCRIPT" > "$INSTALLED_HOST"
chmod +x "$INSTALLED_HOST"
echo "Installed host: $INSTALLED_HOST"

# 3. Get extension ID
echo
echo "To find your extension ID:"
echo "  1. Open chrome://extensions in Chrome"
echo "  2. Enable 'Developer mode' (top right)"
echo "  3. Load the extension folder: $SCRIPT_DIR/extension"
echo "  4. Copy the extension ID shown below the extension name"
echo
read -rp "Enter the extension ID: " EXT_ID

if [[ -z "$EXT_ID" ]]; then
  echo "ERROR: Extension ID is required."
  exit 1
fi

# Validate extension ID format (32 lowercase letters)
if [[ ! "$EXT_ID" =~ ^[a-z]{32}$ ]]; then
  echo "WARNING: Extension ID should be 32 lowercase letters. Continuing anyway..."
fi

# 4. Write native messaging manifest
mkdir -p "$NMH_DIR"
cat > "$MANIFEST_PATH" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Chrome Profile Switcher native messaging host",
  "path": "$INSTALLED_HOST",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXT_ID/"
  ]
}
EOF
echo
echo "Installed native messaging manifest:"
echo "  $MANIFEST_PATH"

echo
echo "Done! Now load the extension in BOTH Chrome profiles:"
echo "  1. Open chrome://extensions in each profile"
echo "  2. Enable 'Developer mode'"
echo "  3. Click 'Load unpacked' → select: $SCRIPT_DIR/extension"
echo
echo "The extension should show the other profile's picture in the toolbar."
