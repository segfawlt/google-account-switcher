// @ts-check

import { STORAGE_KEY, createInitialState } from "../core/constants.js";
import { hasExtensionApi, loadState, sanitizeState, saveState } from "../core/storage.js";
import { isCoveredByBuiltinPermissions } from "../core/url-rules.js";

/**
 * @typedef {import("../core/constants.js").ExtensionState} ExtensionState
 * @typedef {import("../core/constants.js").ThemePreference} ThemePreference
 * @typedef {import("../core/constants.js").TabSessionRecord} TabSessionRecord
 */

const THEME_CACHE_KEY = "accountSwitcherTheme";

/**
 * Apply theme preference (`system`, `light`, `dark`) to document root and cache for zero-FOUC boot.
 * @param {ThemePreference} theme
 */
export function applyThemeToDocument(theme) {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", theme);
  try {
    globalThis.localStorage?.setItem(THEME_CACHE_KEY, theme);
  } catch {
    // Ignore storage restriction
  }
}

/**
 * Apply cached theme immediately before async storage resolves.
 */
function initEarlyTheme() {
  if (typeof document === "undefined") return;
  if (typeof location !== "undefined") {
    const qTheme = new URLSearchParams(location.search).get("theme");
    if (qTheme === "light" || qTheme === "dark" || qTheme === "system") {
      document.documentElement.setAttribute("data-theme", qTheme);
      return;
    }
  }
  try {
    const cached = globalThis.localStorage?.getItem(THEME_CACHE_KEY);
    if (cached === "light" || cached === "dark" || cached === "system") {
      document.documentElement.setAttribute("data-theme", cached);
    }
  } catch {
    // Ignore
  }
}

initEarlyTheme();

/**
 * @typedef {Object} ActiveTabInfo
 * @property {number} id
 * @property {string} url
 * @property {string} title
 * @property {TabSessionRecord | null} tabRecord
 */

/**
 * Build realistic preview state ONLY when opened outside Firefox WebExtension with `?demo=...`.
 * @param {string | null} demoMode
 * @returns {ExtensionState | null}
 */
function buildPreviewFixtureState(demoMode) {
  if (!demoMode || demoMode === "empty") return null;

  const base = createInitialState();
  base.defaultAccountEmail = "work@rivera.dev";
  base.accounts = [
    { email: "alex.rivera@gmail.com", index: 0, name: "Alex Rivera", hidden: false },
    { email: "sam.chen@gmail.com", index: 1, name: "Sam Chen", hidden: false },
    { email: "alex@northstar.studio", index: 2, name: "Northstar Studio", hidden: false },
    { email: "archive.box@gmail.com", index: 3, name: "Archive", hidden: false },
    { email: "work@rivera.dev", index: 4, name: "Rivera Engineering", hidden: false },
  ];

  for (const svc of base.services) {
    if (svc.id === "docs.google.com" || svc.id === "drive.google.com" || svc.id === "meet.google.com") {
      svc.enabled = true;
    }
    if (svc.id === "classroom.google.com") {
      svc.enabled = true;
      svc.accountEmail = "alex@northstar.studio";
    }
  }

  if (demoMode === "managed") {
    base.services.unshift({
      id: "antigravity.google.com",
      label: "antigravity.google.com",
      host: "antigravity.google.com",
      pathPrefix: "",
      enabled: true,
      accountEmail: null,
      custom: true,
    });
  }

  return base;
}

/**
 * Load extension state (or standalone preview fixture when `?demo=` is present outside Firefox).
 * @returns {Promise<ExtensionState>}
 */
export async function getInitialUiState() {
  if (!hasExtensionApi() && typeof location !== "undefined") {
    const params = new URLSearchParams(location.search);
    const demo = params.get("demo");
    const qTheme = params.get("theme");
    const fixture = buildPreviewFixtureState(demo);
    if (fixture) {
      if (qTheme === "light" || qTheme === "dark" || qTheme === "system") {
        fixture.theme = qTheme;
      }
      applyThemeToDocument(fixture.theme);
      return fixture;
    }
  }
  const state = await loadState();
  applyThemeToDocument(state.theme);
  return state;
}

/**
 * Persist updated state.
 * @param {ExtensionState} state
 * @returns {Promise<ExtensionState>}
 */
export async function persistUiState(state) {
  applyThemeToDocument(state.theme);
  return saveState(state);
}

/**
 * Subscribe to external state updates (for example, background auto-sync completing while UI is open).
 * @param {(nextState: ExtensionState) => void} callback
 */
export function subscribeToStateChanges(callback) {
  if (!hasExtensionApi() || !browser.storage?.onChanged) return;
  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes[STORAGE_KEY]) {
      const next = sanitizeState(changes[STORAGE_KEY].newValue);
      applyThemeToDocument(next.theme);
      callback(next);
    }
  });
}

/**
 * Inspect the currently active browser tab in the current window.
 * @returns {Promise<ActiveTabInfo | null>}
 */
export async function queryActiveTabInfo() {
  if (!hasExtensionApi()) {
    if (typeof location !== "undefined") {
      const demo = new URLSearchParams(location.search).get("demo");
      if (demo === "unlisted") {
        return {
          id: 101,
          url: "https://antigravity.google.com/workspace",
          title: "Google Antigravity",
          tabRecord: null,
        };
      }
      if (demo === "managed") {
        return {
          id: 102,
          url: "https://docs.google.com/document/u/4/",
          title: "Google Docs",
          tabRecord: { ruleId: "docs.google.com", host: "docs.google.com", enforcedTarget: 4 },
        };
      }
    }
    return null;
  }

  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    const active = tabs[0];
    if (!active || active.id === undefined || !active.url) {
      return null;
    }

    let tabRecord = null;
    try {
      const ctx = /** @type {{ ok?: boolean; tabRecord?: TabSessionRecord | null }} */ (
        await browser.runtime.sendMessage({ type: "GET_TAB_CONTEXT", tabId: active.id })
      );
      tabRecord = ctx?.tabRecord || null;
    } catch {
      // Background waking up
    }

    return {
      id: active.id,
      url: active.url,
      title: active.title || "",
      tabRecord,
    };
  } catch {
    return null;
  }
}

/**
 * Request optional host permission synchronously inside a user-gesture handler when needed.
 * Note: Firefox requires `browser.permissions.request()` BEFORE any `await` in the click stack.
 *
 * @param {string} host
 * @param {string} originPattern
 * @returns {Promise<boolean>}
 */
export function requestHostPermissionIfNeeded(host, originPattern) {
  if (isCoveredByBuiltinPermissions(host)) {
    return Promise.resolve(true);
  }
  if (!hasExtensionApi() || !browser.permissions?.request) {
    return Promise.resolve(true);
  }
  const bare = host.startsWith("*.") ? host.slice(2) : host;
  const origins = host.startsWith("*.")
    ? [originPattern, `https://${bare}/*`]
    : [originPattern, `https://www.${bare}/*`];

  return browser.permissions.request({ origins }).catch(() => false);
}

/**
 * Check whether host permission is currently granted for a rule's host.
 * @param {string} host
 * @returns {Promise<boolean>}
 */
export async function checkHostPermissionGranted(host) {
  if (isCoveredByBuiltinPermissions(host)) return true;
  if (!hasExtensionApi() || !browser.permissions?.contains) return true;

  const bare = host.startsWith("*.") ? host.slice(2) : host;
  const origin = host.startsWith("*.") ? `https://*.${bare}/*` : `https://${bare}/*`;
  try {
    return await browser.permissions.contains({ origins: [origin] });
  } catch {
    return false;
  }
}

/**
 * Trigger Google `ListAccounts` manual sync via background script (un-hides removed accounts).
 * @returns {Promise<{ ok: true; state: ExtensionState; importedCount: number } | { ok: false; error: string }>}
 */
export async function triggerGoogleImport() {
  if (!hasExtensionApi()) {
    const sample = buildPreviewFixtureState("unlisted");
    if (sample) {
      const saved = await saveState(sample);
      return { ok: true, state: saved, importedCount: 5 };
    }
    return { ok: false, error: "Firefox WebExtension runtime is required to read Google cookies." };
  }

  const res = /** @type {{ ok: boolean; state?: ExtensionState; importedCount?: number; error?: string }} */ (
    await browser.runtime.sendMessage({ type: "IMPORT_GOOGLE_ACCOUNTS" })
  );
  if (res?.ok && res.state) {
    return { ok: true, state: res.state, importedCount: res.importedCount ?? 0 };
  }
  return { ok: false, error: res?.error || "Could not sync signed-in accounts from Google." };
}

/**
 * Trigger silent background account sync (keeps removed accounts hidden and respects 2-min cooldown).
 * @param {boolean} [force]
 * @returns {Promise<{ ok: boolean; skipped?: boolean; state?: ExtensionState; importedCount?: number }>}
 */
export async function triggerAutoSyncAccounts(force = false) {
  if (!hasExtensionApi()) {
    return { ok: true, skipped: true };
  }
  try {
    return /** @type {{ ok: boolean; skipped?: boolean; state?: ExtensionState; importedCount?: number }} */ (
      await browser.runtime.sendMessage({ type: "AUTO_SYNC_GOOGLE_ACCOUNTS", force })
    );
  } catch {
    return { ok: false };
  }
}

/**
 * Tell background script to apply/redirect the active tab immediately.
 * @param {number} tabId
 */
export async function applyRuleToActiveTab(tabId) {
  if (!hasExtensionApi() || tabId < 0) return;
  try {
    await browser.runtime.sendMessage({ type: "APPLY_RULE_TO_TAB", tabId });
  } catch {
    // Ignore
  }
}

/**
 * Pause or resume redirection on a single tab.
 * @param {number} tabId
 * @param {boolean} paused
 * @param {boolean} [applyNow]
 * @returns {Promise<TabSessionRecord | null>}
 */
export async function setActiveTabPaused(tabId, paused, applyNow = false) {
  if (!hasExtensionApi() || tabId < 0) {
    return { paused };
  }
  const res = /** @type {{ tabRecord?: TabSessionRecord | null }} */ (
    await browser.runtime.sendMessage({
      type: "SET_TAB_PAUSED",
      tabId,
      paused,
      applyNow,
    })
  );
  return res?.tabRecord || null;
}

/**
 * Notify background script to refresh dynamic custom host `webRequest` listeners.
 */
export async function notifySyncCustomListeners() {
  if (!hasExtensionApi()) return;
  try {
    await browser.runtime.sendMessage({ type: "SYNC_CUSTOM_LISTENERS" });
  } catch {
    // Ignore
  }
}

/**
 * Open the extension's full settings tab (`options.html`).
 */
export async function openFullOptionsPage() {
  if (hasExtensionApi() && browser.runtime?.openOptionsPage) {
    await browser.runtime.openOptionsPage();
    window.close();
    return;
  }
  window.location.href = "../options/options.html";
}
