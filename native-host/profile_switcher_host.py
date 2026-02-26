#!/usr/bin/env python3
"""Chrome Profile Switcher - Native Messaging Host.

Communicates with the Chrome extension via stdio using Chrome's native
messaging protocol (4-byte little-endian length prefix + JSON body).

Uses a file-based signal mechanism for inter-profile communication:
when switching profiles, writes a signal file that the target profile's
host instance watches for and relays to its extension.

Actions:
  get-profiles       — enumerate Chrome profiles with avatars and metadata
  register           — register this instance's profile dir, start watcher
  switch-profile     — signal target profile to focus, or launch if not running
  open-url-in-profile — signal target to open URL, or launch if not running
"""

import base64
import json
import os
import struct
import subprocess
import sys
import threading
import time
from pathlib import Path

CHROME_DIR = Path.home() / "Library" / "Application Support" / "Google" / "Chrome"
CHROME_BIN = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
LOCAL_STATE = CHROME_DIR / "Local State"
SIGNAL_DIR = Path("/tmp/chrome-profile-switcher")

stdout_lock = threading.Lock()


def read_message():
    """Read a native messaging message from stdin."""
    raw_length = sys.stdin.buffer.read(4)
    if len(raw_length) < 4:
        sys.exit(0)
    length = struct.unpack("<I", raw_length)[0]
    data = sys.stdin.buffer.read(length)
    if len(data) < length:
        sys.exit(0)
    return json.loads(data.decode("utf-8"))


def send_message(msg):
    """Write a native messaging message to stdout (thread-safe)."""
    encoded = json.dumps(msg, separators=(",", ":")).encode("utf-8")
    with stdout_lock:
        sys.stdout.buffer.write(struct.pack("<I", len(encoded)))
        sys.stdout.buffer.write(encoded)
        sys.stdout.buffer.flush()


def highlight_color_to_hex(value):
    """Convert Chrome's signed 32-bit highlight color int to a #rrggbb hex string."""
    if value is None:
        return None
    unsigned = value & 0xFFFFFFFF
    r = (unsigned >> 16) & 0xFF
    g = (unsigned >> 8) & 0xFF
    b = unsigned & 0xFF
    return f"#{r:02x}{g:02x}{b:02x}"


def read_avatar_base64(profile_dir):
    """Read a profile's Google Profile Picture as a base64 data URI."""
    pic_path = CHROME_DIR / profile_dir / "Google Profile Picture.png"
    if not pic_path.exists():
        return None
    try:
        data = pic_path.read_bytes()
        b64 = base64.b64encode(data).decode("ascii")
        return f"data:image/png;base64,{b64}"
    except OSError:
        return None


def profile_sort_key(dirname):
    """Sort Default first, then Profile N in numeric order."""
    if dirname == "Default":
        return (0, 0)
    try:
        num = int(dirname.split()[-1])
        return (1, num)
    except (ValueError, IndexError):
        return (2, 0)


def get_profiles(current_email):
    """Read Chrome's Local State and return profile information."""
    try:
        local_state = json.loads(LOCAL_STATE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        return {"error": f"Failed to read Local State: {e}"}

    info_cache = local_state.get("profile", {}).get("info_cache", {})
    if not info_cache:
        return {"error": "No profiles found in Local State"}

    profiles = []
    current_index = None
    sorted_dirs = sorted(info_cache.keys(), key=profile_sort_key)

    for i, dirname in enumerate(sorted_dirs):
        info = info_cache[dirname]
        user_name = info.get("user_name", "")
        name = info.get("name", dirname)
        highlight_color = highlight_color_to_hex(info.get("profile_highlight_color"))
        avatar = read_avatar_base64(dirname)

        profile = {
            "directory": dirname,
            "name": name,
            "email": user_name,
            "highlightColor": highlight_color,
            "avatar": avatar,
        }
        profiles.append(profile)

        if current_email and user_name == current_email:
            current_index = i

    return {"profiles": profiles, "currentIndex": current_index}


# ---------------------------------------------------------------------------
# Signal-based inter-profile communication
# ---------------------------------------------------------------------------

def write_signal(profile_dir, data=None):
    """Write a signal file for the target profile."""
    SIGNAL_DIR.mkdir(exist_ok=True)
    signal_file = SIGNAL_DIR / profile_dir
    payload = json.dumps(data or {})
    signal_file.write_text(payload, encoding="utf-8")


def read_signal(profile_dir):
    """Read and delete a signal file. Returns parsed data or None."""
    signal_file = SIGNAL_DIR / profile_dir
    if not signal_file.exists():
        return None
    try:
        data = json.loads(signal_file.read_text(encoding="utf-8"))
        signal_file.unlink()
        return data
    except (OSError, json.JSONDecodeError):
        try:
            signal_file.unlink()
        except OSError:
            pass
        return None


def wait_for_signal_consumed(profile_dir, timeout=2.0):
    """Wait for a signal file to be consumed (deleted). Returns True if consumed."""
    signal_file = SIGNAL_DIR / profile_dir
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not signal_file.exists():
            return True
        time.sleep(0.1)
    # Timed out — clean up
    try:
        signal_file.unlink()
    except OSError:
        pass
    return False


def signal_watcher(profile_dir):
    """Background thread: watch for activation signals for this profile."""
    while True:
        signal = read_signal(profile_dir)
        if signal is not None:
            url = signal.get("url")
            if url:
                send_message({"action": "open-url", "url": url})
            else:
                send_message({"action": "activate"})
        time.sleep(0.3)


def activate_chrome():
    """Bring Chrome to the foreground via AppleScript."""
    subprocess.Popen(
        ["osascript", "-e", 'tell application "Google Chrome" to activate'],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def switch_profile(profile_dir):
    """Signal the target profile to focus, or launch Chrome if not running."""
    activate_chrome()
    write_signal(profile_dir)

    if wait_for_signal_consumed(profile_dir):
        return {"success": True, "method": "signal"}

    # Target profile not running — launch it
    try:
        subprocess.Popen(
            [CHROME_BIN, f"--profile-directory={profile_dir}"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        return {"success": True, "method": "launch"}
    except OSError as e:
        return {"error": f"Failed to launch Chrome: {e}"}


def open_url_in_profile(profile_dir, url):
    """Signal the target profile to open a URL, or launch Chrome with it."""
    activate_chrome()
    write_signal(profile_dir, {"url": url})

    if wait_for_signal_consumed(profile_dir):
        return {"success": True, "method": "signal"}

    # Target profile not running — launch it with the URL
    try:
        subprocess.Popen(
            [CHROME_BIN, f"--profile-directory={profile_dir}", url],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        return {"success": True, "method": "launch"}
    except OSError as e:
        return {"error": f"Failed to launch Chrome: {e}"}


def main():
    watcher_started = False

    while True:
        msg = read_message()
        action = msg.get("action")
        msg_id = msg.get("id")

        if action == "register":
            profile_dir = msg.get("profileDir")
            if profile_dir and not watcher_started:
                t = threading.Thread(
                    target=signal_watcher, args=(profile_dir,), daemon=True
                )
                t.start()
                watcher_started = True
            result = {"success": True}

        elif action == "get-profiles":
            result = get_profiles(msg.get("currentEmail"))

        elif action == "switch-profile":
            result = switch_profile(msg.get("profileDir"))

        elif action == "open-url-in-profile":
            result = open_url_in_profile(msg.get("profileDir"), msg.get("url"))

        else:
            result = {"error": f"Unknown action: {action}"}

        if msg_id is not None:
            result["id"] = msg_id

        send_message(result)


if __name__ == "__main__":
    import traceback
    try:
        sys.stderr.write("Native host starting\n")
        sys.stderr.flush()
        main()
    except Exception:
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)
