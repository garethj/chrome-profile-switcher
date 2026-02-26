/* Chrome Profile Switcher — Service Worker (MV3)
 *
 * Connects to the native messaging host to enumerate profiles, then:
 *   - Sets the toolbar icon to the *next* profile's avatar
 *   - Switches to the next profile on toolbar click
 *   - Offers "Move tab to <Name>" context menu items
 *
 * Uses a signal-based mechanism for inter-profile communication:
 * the native host in each profile watches for signal files and relays
 * "activate" or "open-url" messages back to the extension, which then
 * focuses its own window or opens a tab without creating a new window.
 */

const HOST_NAME = "dev.garethj.chrome_profile_switcher";
const STORAGE_KEY = "profileCache";
const ALARM_NAME = "refreshProfiles";
const ALARM_PERIOD_MINUTES = 30;
const MSG_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// Native messaging wrapper
// ---------------------------------------------------------------------------

let port = null;
let msgId = 0;
const pending = new Map(); // id → { resolve, reject, timer }

function connectNative() {
  if (port) return;
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch (e) {
    showErrorBadge("!", "Run install.sh to enable");
    return;
  }

  port.onMessage.addListener((msg) => {
    // Handle unsolicited messages from the signal watcher
    if (msg.action === "activate") {
      focusOwnWindow();
      return;
    }
    if (msg.action === "open-url" && msg.url) {
      openUrlInOwnWindow(msg.url);
      return;
    }

    // Handle responses to our requests (matched by id)
    const id = msg.id;
    if (id != null && pending.has(id)) {
      const { resolve, timer } = pending.get(id);
      clearTimeout(timer);
      pending.delete(id);
      resolve(msg);
    }
  });

  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    const errMsg = err?.message || "Native host disconnected";
    console.error("[ProfileSwitcher] Native host disconnected:", errMsg);
    for (const [, { reject, timer }] of pending) {
      clearTimeout(timer);
      reject(new Error(errMsg));
    }
    pending.clear();
    port = null;
  });
}

function sendNative(message) {
  return new Promise((resolve, reject) => {
    connectNative();
    if (!port) {
      reject(new Error("Native host not connected"));
      return;
    }
    const id = ++msgId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Native message timeout"));
    }, MSG_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    port.postMessage({ ...message, id });
  });
}

// ---------------------------------------------------------------------------
// Window management (responding to signals from other profiles)
// ---------------------------------------------------------------------------

async function focusOwnWindow() {
  try {
    const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
    if (windows.length > 0) {
      // Focus the most recently focused window
      const target = windows.find((w) => w.focused) || windows[0];
      await chrome.windows.update(target.id, { focused: true });
    }
  } catch (e) {
    console.error("[ProfileSwitcher] Failed to focus window:", e);
  }
}

async function openUrlInOwnWindow(url) {
  try {
    const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
    if (windows.length > 0) {
      const target = windows.find((w) => w.focused) || windows[0];
      await chrome.windows.update(target.id, { focused: true });
      await chrome.tabs.create({ url, windowId: target.id });
    } else {
      await chrome.windows.create({ url });
    }
  } catch (e) {
    console.error("[ProfileSwitcher] Failed to open URL:", e);
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let profiles = [];
let currentIndex = null;
let nextIndex = null;
let currentEmail = null;
let currentProfileDir = null;

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

async function initialize() {
  // Load cache for instant display
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    if (stored[STORAGE_KEY]) {
      const cache = stored[STORAGE_KEY];
      profiles = cache.profiles || [];
      currentIndex = cache.currentIndex;
      currentProfileDir = cache.currentProfileDir;
      computeNext();
      if (nextIndex != null) {
        await updateIcon();
        updateContextMenus();
      }
    }
  } catch (_) {
    // No cache — that's fine
  }

  // Get current email
  try {
    const info = await chrome.identity.getProfileUserInfo({ accountStatus: "ANY" });
    currentEmail = info.email || null;
  } catch (_) {
    currentEmail = null;
  }

  if (!currentEmail) {
    showErrorBadge("?", "Sign in to Chrome to use");
    return;
  }

  // Fetch fresh profile data
  await refreshProfiles();
}

async function refreshProfiles() {
  try {
    const result = await sendNative({
      action: "get-profiles",
      currentEmail,
    });

    if (result.error) {
      showErrorBadge("!", result.error);
      return;
    }

    profiles = result.profiles || [];
    currentIndex = result.currentIndex;

    // Determine our profile directory
    if (currentIndex != null && profiles[currentIndex]) {
      currentProfileDir = profiles[currentIndex].directory;

      // Register with native host so it watches for signals targeting us
      sendNative({
        action: "register",
        profileDir: currentProfileDir,
      }).catch(() => {}); // Fire and forget
    }

    // Cache for service worker restarts
    await chrome.storage.local.set({
      [STORAGE_KEY]: { profiles, currentIndex, currentProfileDir },
    });

    computeNext();

    if (profiles.length < 2) {
      chrome.action.disable();
      chrome.action.setTitle({ title: "Only one profile" });
      return;
    }

    chrome.action.enable();
    await updateIcon();
    updateContextMenus();
  } catch (e) {
    // Retry once after a short delay
    try {
      await new Promise((r) => setTimeout(r, 100));
      connectNative();
      const result = await sendNative({
        action: "get-profiles",
        currentEmail,
      });
      if (!result.error) {
        profiles = result.profiles || [];
        currentIndex = result.currentIndex;
        if (currentIndex != null && profiles[currentIndex]) {
          currentProfileDir = profiles[currentIndex].directory;
          sendNative({
            action: "register",
            profileDir: currentProfileDir,
          }).catch(() => {});
        }
        await chrome.storage.local.set({
          [STORAGE_KEY]: { profiles, currentIndex, currentProfileDir },
        });
        computeNext();
        if (profiles.length >= 2) {
          chrome.action.enable();
          await updateIcon();
          updateContextMenus();
        }
      } else {
        showErrorBadge("!", result.error);
      }
    } catch (_) {
      showErrorBadge("!", "Run install.sh to enable");
    }
  }
}

function computeNext() {
  if (currentIndex == null || profiles.length < 2) {
    nextIndex = null;
    return;
  }
  nextIndex = (currentIndex + 1) % profiles.length;
}

// ---------------------------------------------------------------------------
// Toolbar icon rendering
// ---------------------------------------------------------------------------

async function updateIcon() {
  if (nextIndex == null || !profiles[nextIndex]) return;

  const target = profiles[nextIndex];
  chrome.action.setTitle({ title: `Switch to ${target.name}` });
  chrome.action.setBadgeText({ text: "" });

  const sizes = [16, 32, 48];
  const imageData = {};

  for (const size of sizes) {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext("2d");

    if (target.avatar) {
      try {
        const response = await fetch(target.avatar);
        const blob = await response.blob();
        const bitmap = await createImageBitmap(blob);

        // Draw circular-clipped avatar
        ctx.beginPath();
        ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(bitmap, 0, 0, size, size);
        bitmap.close();
      } catch (_) {
        drawFallbackIcon(ctx, size, target);
      }
    } else {
      drawFallbackIcon(ctx, size, target);
    }

    imageData[size] = ctx.getImageData(0, 0, size, size);
  }

  chrome.action.setIcon({ imageData });
}

function drawFallbackIcon(ctx, size, profile) {
  const color = profile.highlightColor || "#666666";
  const initial = (profile.name || "?")[0].toUpperCase();

  // Colored circle
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();

  // Initial letter
  ctx.fillStyle = isLightColor(color) ? "#000000" : "#ffffff";
  ctx.font = `bold ${Math.round(size * 0.55)}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(initial, size / 2, size / 2 + 1);
}

function isLightColor(hex) {
  if (!hex) return false;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return r * 0.299 + g * 0.587 + b * 0.114 > 150;
}

// ---------------------------------------------------------------------------
// Context menus
// ---------------------------------------------------------------------------

async function updateContextMenus() {
  await chrome.contextMenus.removeAll();
  if (profiles.length < 2 || currentIndex == null) return;

  for (let i = 0; i < profiles.length; i++) {
    if (i === currentIndex) continue;
    const profile = profiles[i];
    chrome.contextMenus.create({
      id: `move-tab-${profile.directory}`,
      title: `Move tab to ${profile.name}`,
      contexts: ["page", "action"],
    });
  }
}

// ---------------------------------------------------------------------------
// Event listeners (registered synchronously — MV3 requirement)
// ---------------------------------------------------------------------------

// Toolbar button click → switch to next profile
chrome.action.onClicked.addListener(async () => {
  if (nextIndex == null || !profiles[nextIndex]) {
    await initialize();
    return;
  }

  const target = profiles[nextIndex];
  try {
    await sendNative({
      action: "switch-profile",
      profileDir: target.directory,
    });
  } catch (e) {
    showErrorBadge("!", e.message);
  }
});

// Context menu click → move tab to selected profile
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const prefix = "move-tab-";
  if (!info.menuItemId.startsWith(prefix)) return;

  const profileDir = info.menuItemId.slice(prefix.length);
  const url = tab?.url || info.pageUrl;

  if (!url || url.startsWith("chrome://") || url.startsWith("chrome-extension://")) {
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#cc0000" });
    chrome.action.setTitle({ title: "Cannot move chrome:// URLs" });
    setTimeout(() => {
      chrome.action.setBadgeText({ text: "" });
      if (nextIndex != null && profiles[nextIndex]) {
        chrome.action.setTitle({
          title: `Switch to ${profiles[nextIndex].name}`,
        });
      }
    }, 3000);
    return;
  }

  try {
    const result = await sendNative({
      action: "open-url-in-profile",
      profileDir,
      url,
    });
    // Close tab after the URL has been opened in the other profile
    if (result.success && tab?.id) {
      setTimeout(() => chrome.tabs.remove(tab.id), 300);
    }
  } catch (e) {
    showErrorBadge("!", e.message);
  }
});

// Extension installed or updated
chrome.runtime.onInstalled.addListener(() => {
  initialize();
});

// Service worker started (browser launch or wake from idle)
chrome.runtime.onStartup.addListener(() => {
  initialize();
});

// Periodic refresh for profile picture changes
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    refreshProfiles();
  }
});

// Set up periodic alarm
chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MINUTES });

// ---------------------------------------------------------------------------
// Error display
// ---------------------------------------------------------------------------

function showErrorBadge(text, title) {
  console.error("[ProfileSwitcher] Error badge:", text, title);
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: "#cc0000" });
  chrome.action.setTitle({ title });
}

// ---------------------------------------------------------------------------
// Run initialization on script load (handles service worker restart)
// ---------------------------------------------------------------------------

initialize();
