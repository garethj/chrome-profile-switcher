# Chrome Profile Switcher

A Chrome extension + native messaging host that adds one-click profile switching to the toolbar.

## Features

- **Toolbar button** shows the other profile's avatar — click to switch/focus that profile's window
- **Context menu** on any page: "Move tab to \<Profile\>" opens the URL in the other profile and closes the tab
- If the target profile is already open, focuses its existing window instead of opening a new one
- Works with any number of Chrome profiles

## Setup

### 1. Load the extension

1. Open `chrome://extensions` in Chrome
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked** and select the `extension/` folder
4. Copy the **extension ID** shown under the extension name
5. Repeat in your other Chrome profile(s)

> The extension ID will be the same across profiles since it's loaded from the same directory.

### 2. Install the native messaging host

```sh
./install.sh
```

The script will:
- Find your Python 3 installation (supports pyenv)
- Install the host script to `~/.local/bin/` (Chrome native messaging requires a path without spaces)
- Set the correct Python shebang for your system
- Ask for your extension ID
- Write the native messaging manifest to Chrome's `NativeMessagingHosts` directory

### 3. Reload the extension

After running `install.sh`, reload the extension in each profile (`chrome://extensions` -> reload icon). The toolbar icon should update to show the other profile's picture.

## How it works

```
Extension (Profile A)  ->  Native Host (Python)  ->  Signal file  ->  Native Host (Profile B)  ->  Extension (Profile B)
```

1. Each profile's extension connects to its own native host process via Chrome's native messaging (stdio JSON protocol)
2. The native host reads Chrome's `Local State` file to enumerate profiles and their avatars
3. When switching profiles, the host writes a signal file that the target profile's host watches for
4. The target profile's extension receives the activation signal and focuses its own window
5. If the target profile isn't running, falls back to launching Chrome with `--profile-directory`

## Requirements

- macOS (paths are macOS-specific)
- Python 3 (no external dependencies)
- Chrome with multiple profiles configured
