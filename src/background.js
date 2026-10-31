// @ts-check

import { POPUP_SYNC_COOLDOWN_MS, STORAGE_KEY, createInitialState } from "./core/constants.js";
import { fetchGoogleAccounts } from "./core/google-accounts.js";
import {
  applyImportedAccounts,
  loadSessionTabs,
  loadState,
   sanitizeState,
  saveSessionTabs,
  saveState,
} from "./core/storage.js";
import {
  buildRedirectUrl,
  evaluateNavigationRequest,
  isCoveredByBuiltinPermissions,
  isExcludedUrl,
  matchServiceRule,
  normalizeHost,
  resolveTargetAccount,
} from "./core/url-rules.js";

/**
 * @typedef {import("./core/constants.js").ExtensionState} ExtensionState
 * @typedef {import("./core/constants.js").TabSessionRecord} TabSessionRecord
 */

/** @type {ExtensionState | null} */
let cachedState = null;

/** @type {Record<string, TabSessionRecord & { redirectCount?: number }>} */
let cachedTabs = {};

/** @type {Promise<void> | null} */
let hydrationPromise = null;

/** @type {((details: browser.webRequest._OnBeforeRequestDetails) => Promise<browser.webRequest.BlockingResponse>) | null} */
let dynamicCustomListener = null;

/** @type {Promise<{ ok: boolean; skipped?: boolean; importedCount?: number; state?: ExtensionState; error?: string }> | null} */
let inFlightAccountSync = null;

/** @type {ReturnType<typeof setTimeout> | null} */
let accountPageSyncTimer = null;

/**
 * Ensure state and per-tab session records are hydrated into memory.
 * @returns {Promise<ExtensionState>}
 */
async function ensureHydrated() {
  if (cachedState) {
    return cachedState;
  }
  if (!hydrationPromise) {
    hydrationPromise = (async () => {
      const [loadedState, loadedTabs] = await Promise.all([loadState(), loadSessionTabs()]);
      cachedState = loadedState;
      cachedTabs = loadedTabs;
    })().finally(() => {
      hydrationPromise = null;
    });
  }
  await hydrationPromise;
  return cachedState || createInitialState();
}

/**
 * Persist updated per-tab session state in memory and `browser.storage.session`.
 * @param {number} tabId
 * @param {(TabSessionRecord & { redirectCount?: number }) | undefined} record
 */
async function updateTabRecord(tabId, record) {
  if (tabId < 0) return;
  const key = String(tabId);
  if (!record) {
    delete cachedTabs[key];
  } else {
    cachedTabs[key] = record;
  }
  await saveSessionTabs(cachedTabs);
}

/**
 * Primary `webRequest.onBeforeRequest` handler for `main_frame` navigations.
 * Registered synchronously at module load so Firefox MV3 event page wakeups never drop events.
 *
 * @param {browser.webRequest._OnBeforeRequestDetails} details
 * @returns {Promise<browser.webRequest.BlockingResponse>}
 */
async function handleBeforeRequest(details) {
  const state = await ensureHydrated();
  const tabKey = String(details.tabId);
  const currentTabRecord = cachedTabs[tabKey];

  const decision = evaluateNavigationRequest({
    urlString: details.url,
    method: details.method,
    resourceType: details.type,
    tabId: details.tabId,
    originUrlString: details.originUrl,
    state,
    tabRecord: currentTabRecord,
    now: Date.now(),
  });

  if (decision.nextTabRecord) {
    await updateTabRecord(details.tabId, decision.nextTabRecord);
  }

  if (decision.action === "redirect" && decision.redirectUrl) {
    return { redirectUrl: decision.redirectUrl };
  }
  return {};
}

/**
 * Rewrite `Origin` header on extension-initiated `ListAccounts` requests so Google GAIA
 * accepts requests originating from `moz-extension://` identically to `https://www.google.com`.
 *
 * @param {browser.webRequest._OnBeforeSendHeadersDetails} details
 * @returns {browser.webRequest.BlockingResponse}
 */
function handleListAccountsHeaders(details) {
  const extBase = browser.runtime.getURL("");
  if (!details.originUrl || !details.originUrl.startsWith(extBase)) {
    return {};
  }
  const headers = (details.requestHeaders || []).filter(
    (h) => h.name.toLowerCase() !== "origin" && h.name.toLowerCase() !== "referer"
  );
  headers.push({ name: "Origin", value: "https://www.google.com" });
  return { requestHeaders: headers };
}

/**
 * Synchronize optional `webRequest` listener for any user-added non-`*.google.com` custom domains.
 * @param {ExtensionState} state
 */
async function syncCustomHostListeners(state) {
  if (dynamicCustomListener && browser.webRequest.onBeforeRequest.hasListener(dynamicCustomListener)) {
    browser.webRequest.onBeforeRequest.removeListener(dynamicCustomListener);
    dynamicCustomListener = null;
  }

  /** @type {string[]} */
  const extraOrigins = [];
  for (const svc of state.services) {
    if (!svc.enabled || isCoveredByBuiltinPermissions(svc.host)) continue;
    const bare = svc.host.startsWith("*.") ? svc.host.slice(2) : svc.host;
    const patterns = svc.host.startsWith("*.")
      ? [`https://*.${bare}/*`, `https://${bare}/*`]
      : [`https://${bare}/*`, `https://www.${bare}/*`];

    for (const pattern of patterns) {
      try {
        const granted = await browser.permissions.contains({ origins: [pattern] });
        if (granted && !extraOrigins.includes(pattern)) {
          extraOrigins.push(pattern);
        }
      } catch {
        // Ignore invalid origin checks
      }
    }
  }

  if (extraOrigins.length > 0) {
    dynamicCustomListener = (details) => handleBeforeRequest(details);
    browser.webRequest.onBeforeRequest.addListener(
      dynamicCustomListener,
      { urls: extraOrigins, types: ["main_frame"] },
      ["blocking"]
    );
  }
}

/**
 * Update toolbar badge for a specific tab to show active routed slot (`u/4`), manual override, or paused state.
 * @param {number} tabId
 * @param {string} [tabUrl]
 */
async function refreshBadgeForTab(tabId, tabUrl) {
  if (tabId < 0 || !browser.action) return;

  try {
    const state = await ensureHydrated();
    let urlStr = tabUrl;
    if (!urlStr) {
      const tab = await browser.tabs.get(tabId);
      urlStr = tab.url;
    }

    if (!urlStr || !urlStr.startsWith("https://") || !state.redirectEnabled) {
      await browser.action.setBadgeText({ tabId, text: "" });
      return;
    }

    const url = new URL(urlStr);
    if (isExcludedUrl(url)) {
      await browser.action.setBadgeText({ tabId, text: "" });
      return;
    }

    const rule = matchServiceRule(url, state.services);
    if (!rule) {
      await browser.action.setBadgeText({ tabId, text: "" });
      return;
    }

    const tabRec = cachedTabs[String(tabId)];
    if (tabRec?.paused) {
      await browser.action.setBadgeBackgroundColor({ tabId, color: "#eeeeee" });
      if (browser.action.setBadgeTextColor) {
        await browser.action.setBadgeTextColor({ tabId, color: "#3d3d3d" });
      }
      await browser.action.setBadgeText({ tabId, text: "OFF" });
      return;
    }

    if (
      tabRec?.ruleId === rule.id &&
      tabRec.manualOverrideAccount !== null &&
      tabRec.manualOverrideAccount !== undefined
    ) {
      await browser.action.setBadgeBackgroundColor({ tabId, color: "#eeeeee" });
      if (browser.action.setBadgeTextColor) {
        await browser.action.setBadgeTextColor({ tabId, color: "#3d3d3d" });
      }
      const label =
        typeof tabRec.manualOverrideAccount === "number"
          ? `u/${tabRec.manualOverrideAccount}`
          : "MAN";
      await browser.action.setBadgeText({ tabId, text: label });
      return;
    }

    const target = resolveTargetAccount(rule, state);
    if (!target) {
      await browser.action.setBadgeText({ tabId, text: "" });
      return;
    }

    await browser.action.setBadgeBackgroundColor({ tabId, color: "#141414" });
    if (browser.action.setBadgeTextColor) {
      await browser.action.setBadgeTextColor({ tabId, color: "#ffffff" });
    }
    const badge = target.index !== null ? `u/${target.index}` : target.email.slice(0, 3);
    await browser.action.setBadgeText({ tabId, text: badge });
  } catch {
    // Tab may have closed mid-update
  }
}

/**
 * Refresh badges across currently active window tabs.
 */
async function refreshActiveTabBadges() {
  try {
    const activeTabs = await browser.tabs.query({ active: true });
    await Promise.all(activeTabs.map((t) => (t.id !== undefined ? refreshBadgeForTab(t.id, t.url) : null)));
  } catch {
    // Ignore query failures
  }
}

/**
 * Synchronize Google accounts with single-flight deduplication and optional cooldown.
 * - `revealHidden: true` is used for manual clicks on "Sync from Google".
 * - `revealHidden: false` is used for automatic background syncs so removed accounts stay hidden.
 *
 * @param {{ revealHidden: boolean; force: boolean }} opts
 * @returns {Promise<{ ok: boolean; skipped?: boolean; importedCount?: number; state?: ExtensionState; error?: string }>}
 */
async function syncAccountsFromGoogle(opts) {
  const state = await ensureHydrated();
  const visibleCount = state.accounts.filter((a) => !a.hidden).length;
  const elapsed = Date.now() - (state.lastAccountSyncAt ?? 0);

  if (!opts.force && visibleCount > 0 && elapsed < POPUP_SYNC_COOLDOWN_MS) {
    return {
      ok: true,
      skipped: true,
      importedCount: visibleCount,
      state,
    };
  }

  if (inFlightAccountSync) {
    return inFlightAccountSync;
  }

  inFlightAccountSync = (async () => {
    try {
      const latestState = await ensureHydrated();
      const imported = await fetchGoogleAccounts();
      if (imported.length === 0 && !opts.revealHidden) {
        return {
          ok: true,
          importedCount: 0,
          state: latestState,
        };
      }
      const nextState = applyImportedAccounts(latestState, imported, {
        revealHidden: opts.revealHidden,
        syncedAt: imported.length > 0 ? Date.now() : latestState.lastAccountSyncAt ?? 0,
      });
      cachedState = await saveState(nextState);
      await refreshActiveTabBadges();
      return {
        ok: true,
        importedCount: imported.length,
        state: cachedState,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "Could not sync accounts from Google.",
      };
    } finally {
      inFlightAccountSync = null;
    }
  })();

  return inFlightAccountSync;
}

/**
 * Navigate an existing tab immediately to its configured target account.
 * @param {number} tabId
 * @param {ExtensionState} state
 */
async function enforceRuleOnExistingTab(tabId, state) {
  const tab = await browser.tabs.get(tabId);
  if (!tab.url || !tab.url.startsWith("https://")) return;

  const url = new URL(tab.url);
  if (isExcludedUrl(url)) return;

  const matchedRule = matchServiceRule(url, state.services);
  if (!matchedRule) return;

  const targetAccount = resolveTargetAccount(matchedRule, state);
  if (!targetAccount) return;

  const nextUrl = buildRedirectUrl(url, targetAccount);
  await updateTabRecord(tabId, {
    paused: false,
    ruleId: matchedRule.id,
    host: normalizeHost(url.hostname),
    lastEnforcedAt: Date.now(),
    enforcedTarget: targetAccount.index ?? targetAccount.email,
    manualOverrideAccount: null,
    redirectCount: 1,
  });

  if (nextUrl !== tab.url) {
    await browser.tabs.update(tabId, { url: nextUrl });
  } else {
    await refreshBadgeForTab(tabId, tab.url);
  }
}

// ============================================================================
// Top-level synchronous MV3 event page listener registrations
// ============================================================================

browser.webRequest.onBeforeRequest.addListener(
  handleBeforeRequest,
  { urls: ["https://*.google.com/*"], types: ["main_frame"] },
  ["blocking"]
);

browser.webRequest.onBeforeSendHeaders.addListener(
  handleListAccountsHeaders,
  { urls: ["https://accounts.google.com/ListAccounts*"], types: ["xmlhttprequest"] },
  ["blocking", "requestHeaders"]
);

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[STORAGE_KEY]) {
    cachedState = sanitizeState(changes[STORAGE_KEY].newValue);
    void syncCustomHostListeners(cachedState);
    void refreshActiveTabBadges();
  }
});

browser.tabs.onRemoved.addListener((tabId) => {
  if (cachedTabs[String(tabId)]) {
    void updateTabRecord(tabId, undefined);
  }
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "complete") {
    void refreshBadgeForTab(tabId, tab.url);
  }
  // Automatically refresh accounts shortly after signing in or out on Google Account pages
  if (
    changeInfo.status === "complete" &&
    tab.url &&
    (tab.url.startsWith("https://accounts.google.com/") ||
      tab.url.startsWith("https://myaccount.google.com/"))
  ) {
    if (accountPageSyncTimer) {
      clearTimeout(accountPageSyncTimer);
    }
    accountPageSyncTimer = setTimeout(() => {
      accountPageSyncTimer = null;
      void syncAccountsFromGoogle({ revealHidden: false, force: true });
    }, 1500);
  }
});

browser.tabs.onActivated.addListener(({ tabId }) => {
  void refreshBadgeForTab(tabId);
});

browser.runtime.onInstalled.addListener(async (details) => {
  const state = await ensureHydrated();
  if (details.reason === "install") {
    await saveState(state);
  }
  await syncCustomHostListeners(state);
  await syncAccountsFromGoogle({ revealHidden: false, force: true });
  await refreshActiveTabBadges();
});

browser.runtime.onStartup.addListener(async () => {
  const state = await ensureHydrated();
  await syncCustomHostListeners(state);
  await syncAccountsFromGoogle({ revealHidden: false, force: true });
});

browser.runtime.onMessage.addListener((rawMessage) => {
  const msg = /** @type {Record<string, unknown>} */ (rawMessage || {});

  if (msg.type === "IMPORT_GOOGLE_ACCOUNTS") {
    return syncAccountsFromGoogle({ revealHidden: true, force: true });
  }

  if (msg.type === "AUTO_SYNC_GOOGLE_ACCOUNTS") {
    return syncAccountsFromGoogle({ revealHidden: false, force: Boolean(msg.force) });
  }

  if (msg.type === "GET_TAB_CONTEXT") {
    return (async () => {
      await ensureHydrated();
      const tabId = typeof msg.tabId === "number" ? msg.tabId : -1;
      return {
        ok: true,
        tabRecord: tabId >= 0 ? cachedTabs[String(tabId)] || null : null,
      };
    })();
  }

  if (msg.type === "SET_TAB_PAUSED") {
    return (async () => {
      const state = await ensureHydrated();
      const tabId = typeof msg.tabId === "number" ? msg.tabId : -1;
      const paused = Boolean(msg.paused);
      if (tabId >= 0) {
        const prev = cachedTabs[String(tabId)] || {};
        await updateTabRecord(tabId, {
          ...prev,
          paused,
          ...(paused ? {} : { manualOverrideAccount: null }),
        });
        if (!paused && msg.applyNow) {
          await enforceRuleOnExistingTab(tabId, state);
        } else {
          await refreshBadgeForTab(tabId);
        }
      }
      return { ok: true, tabRecord: tabId >= 0 ? cachedTabs[String(tabId)] || null : null };
    })();
  }

  if (msg.type === "APPLY_RULE_TO_TAB") {
    return (async () => {
      const state = await ensureHydrated();
      const tabId = typeof msg.tabId === "number" ? msg.tabId : -1;
      if (tabId >= 0) {
        await enforceRuleOnExistingTab(tabId, state);
      }
      return { ok: true };
    })();
  }

  if (msg.type === "SYNC_CUSTOM_LISTENERS") {
    return (async () => {
      const state = await ensureHydrated();
      await syncCustomHostListeners(state);
      return { ok: true };
    })();
  }

  return undefined;
});

// Hydrate listeners on cold wakeup and autoload accounts if none exist yet
void ensureHydrated().then(async (state) => {
  await syncCustomHostListeners(state);
  if (state.accounts.filter((a) => !a.hidden).length === 0) {
    await syncAccountsFromGoogle({ revealHidden: false, force: true });
  }
});
