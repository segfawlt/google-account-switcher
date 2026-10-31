// @ts-check

import {
  SESSION_TABS_KEY,
  STARTER_SERVICES,
  STATE_VERSION,
  STORAGE_KEY,
  createInitialState,
} from "./constants.js";
import { mergeImportedAccounts, removeAccountPreservingIndices } from "./google-accounts.js";
import { normalizeServiceInput } from "./url-rules.js";

/**
 * @typedef {import("./constants.js").AccountEntry} AccountEntry
 * @typedef {import("./constants.js").ServiceRule} ServiceRule
 * @typedef {import("./constants.js").ExtensionState} ExtensionState
 * @typedef {import("./constants.js").ThemePreference} ThemePreference
 * @typedef {import("./constants.js").TabSessionRecord} TabSessionRecord
 */

/**
 * Check if WebExtension `browser` APIs are present.
 * @returns {boolean}
 */
export function hasExtensionApi() {
  return typeof browser !== "undefined" && Boolean(browser?.storage?.local);
}

/**
 * Sanitize and merge stored state with any newly added starter services.
 * @param {unknown} raw
 * @returns {ExtensionState}
 */
export function sanitizeState(raw) {
  const fallback = createInitialState();
  if (!raw || typeof raw !== "object") {
    return fallback;
  }

  const obj = /** @type {Record<string, unknown>} */ (raw);
  const redirectEnabled =
    typeof obj.redirectEnabled === "boolean" ? obj.redirectEnabled : fallback.redirectEnabled;

  /** @type {ThemePreference} */
  const theme =
    obj.theme === "light" || obj.theme === "dark" || obj.theme === "system"
      ? obj.theme
      : fallback.theme;

  const lastAccountSyncAt =
    typeof obj.lastAccountSyncAt === "number" && Number.isFinite(obj.lastAccountSyncAt)
      ? obj.lastAccountSyncAt
      : 0;

  /** @type {AccountEntry[]} */
  const accounts = [];
  if (Array.isArray(obj.accounts)) {
    for (const item of obj.accounts) {
      if (!item || typeof item !== "object") continue;
      const entry = /** @type {Record<string, unknown>} */ (item);
      if (typeof entry.email !== "string" || !entry.email.includes("@")) continue;
      const index =
        typeof entry.index === "number" && Number.isInteger(entry.index) && entry.index >= 0
          ? entry.index
          : null;
      accounts.push({
        email: entry.email.trim().toLowerCase(),
        index,
        ...(typeof entry.name === "string" && entry.name ? { name: entry.name } : {}),
        ...(typeof entry.avatar === "string" && entry.avatar ? { avatar: entry.avatar } : {}),
        hidden: Boolean(entry.hidden),
      });
    }
  }

  const visibleEmails = new Set(
    accounts.filter((a) => !a.hidden).map((a) => a.email.toLowerCase())
  );

  let defaultAccountEmail =
    typeof obj.defaultAccountEmail === "string" && obj.defaultAccountEmail.trim()
      ? obj.defaultAccountEmail.trim().toLowerCase()
      : null;

  if (defaultAccountEmail && !visibleEmails.has(defaultAccountEmail)) {
    const firstVisible = accounts.find((a) => !a.hidden);
    defaultAccountEmail = firstVisible ? firstVisible.email : null;
  }

  /** @type {Map<string, ServiceRule>} */
  const byId = new Map();

  for (const starter of fallback.services) {
    byId.set(starter.id, { ...starter });
  }

  if (Array.isArray(obj.services)) {
    for (const item of obj.services) {
      if (!item || typeof item !== "object") continue;
      const rec = /** @type {Record<string, unknown>} */ (item);
      if (typeof rec.id !== "string" || typeof rec.host !== "string") continue;

      const existingStarter = byId.get(rec.id);
      const rawAccount =
        typeof rec.accountEmail === "string" && rec.accountEmail.trim()
          ? rec.accountEmail.trim().toLowerCase()
          : null;
      const validAccount = rawAccount && visibleEmails.has(rawAccount) ? rawAccount : null;

      byId.set(rec.id, {
        id: rec.id,
        label:
          typeof rec.label === "string" && rec.label.trim()
            ? rec.label.trim()
            : existingStarter?.label || rec.id,
        host: rec.host.toLowerCase(),
        pathPrefix: typeof rec.pathPrefix === "string" ? rec.pathPrefix : "",
        enabled: Boolean(rec.enabled),
        accountEmail: validAccount,
        custom: existingStarter ? false : Boolean(rec.custom ?? true),
      });
    }
  }

  // Put custom/enabled services in deterministic order: custom rules & starter order preserved
  const starterIds = new Set(STARTER_SERVICES.map((s) => s.id));
  /** @type {ServiceRule[]} */
  const customRules = [];
  /** @type {ServiceRule[]} */
  const starterRules = [];

  for (const rule of byId.values()) {
    if (starterIds.has(rule.id)) {
      starterRules.push(rule);
    } else {
      customRules.push(rule);
    }
  }

  return {
    version: STATE_VERSION,
    redirectEnabled,
    theme,
    defaultAccountEmail,
    accounts,
    lastAccountSyncAt,
    services: [...customRules, ...starterRules],
  };
}

/**
 * Load persistent ExtensionState from `browser.storage.local` (or preview storage).
 * @returns {Promise<ExtensionState>}
 */
export async function loadState() {
  if (hasExtensionApi()) {
    const result = await browser.storage.local.get(STORAGE_KEY);
    return sanitizeState(result[STORAGE_KEY]);
  }

  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (raw) {
      return sanitizeState(JSON.parse(raw));
    }
  } catch {
    // Ignore localStorage security errors in restricted contexts
  }
  return createInitialState();
}

/**
 * Persist ExtensionState to `browser.storage.local`.
 * @param {ExtensionState} state
 * @returns {Promise<ExtensionState>}
 */
export async function saveState(state) {
  const clean = sanitizeState(state);
  if (hasExtensionApi()) {
    await browser.storage.local.set({ [STORAGE_KEY]: clean });
    return clean;
  }

  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(clean));
  } catch {
    // Ignore preview storage failures
  }
  return clean;
}

/**
 * Pure reducer helpers for state mutations so UI and tests share identical invariants.
 */

/**
 * Apply imported Google accounts to state, auto-selecting the first account as Default if unset.
 * @param {ExtensionState} state
 * @param {ReadonlyArray<AccountEntry>} imported
 * @param {{ revealHidden?: boolean; syncedAt?: number }} [options]
 * @returns {ExtensionState}
 */
export function applyImportedAccounts(state, imported, options = {}) {
  const merged = mergeImportedAccounts(state.accounts, imported, options);
  const firstVisible = merged.find((a) => !a.hidden) || null;
  const defaultAccountEmail =
    state.defaultAccountEmail && merged.some((a) => !a.hidden && a.email === state.defaultAccountEmail)
      ? state.defaultAccountEmail
      : firstVisible
        ? firstVisible.email
        : null;

  const lastAccountSyncAt =
    options.syncedAt !== undefined
      ? options.syncedAt
      : imported.length > 0
        ? Date.now()
        : state.lastAccountSyncAt ?? 0;

  return sanitizeState({
    ...state,
    accounts: merged,
    defaultAccountEmail,
    lastAccountSyncAt,
  });
}

/**
 * Manually add or update an account by email and optional numeric `u/<index>` slot.
 * @param {ExtensionState} state
 * @param {string} rawEmail
 * @param {number | null} slotIndex
 * @returns {{ ok: true; state: ExtensionState } | { ok: false; error: string }}
 */
export function upsertManualAccount(state, rawEmail, slotIndex) {
  const email = rawEmail.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { ok: false, error: "Enter a valid email address." };
  }
  if (slotIndex !== null && (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex > 20)) {
    return { ok: false, error: "Session slot must be a whole number from 0 to 20." };
  }

  const nextAccounts = state.accounts.map((acc) => ({ ...acc }));
  const existingIdx = nextAccounts.findIndex((a) => a.email.toLowerCase() === email);

  if (existingIdx >= 0) {
    nextAccounts[existingIdx] = {
      ...nextAccounts[existingIdx],
      email,
      index: slotIndex !== null ? slotIndex : nextAccounts[existingIdx].index,
      hidden: false,
    };
  } else {
    nextAccounts.push({
      email,
      index: slotIndex,
      hidden: false,
    });
  }

  const defaultAccountEmail = state.defaultAccountEmail || email;
  return {
    ok: true,
    state: sanitizeState({
      ...state,
      accounts: nextAccounts,
      defaultAccountEmail,
    }),
  };
}

/**
 * Remove an account from visible list without shifting other accounts' `u/<index>` slots.
 * @param {ExtensionState} state
 * @param {string} email
 * @returns {ExtensionState}
 */
export function removeAccountFromState(state, email) {
  const nextAccounts = removeAccountPreservingIndices(state.accounts, email);
  return sanitizeState({
    ...state,
    accounts: nextAccounts,
  });
}

/**
 * Add or enable a service rule in the allowlist.
 * @param {ExtensionState} state
 * @param {string} rawServiceInput
 * @param {{ keepPath?: boolean; customLabel?: string; accountEmail?: string | null; enabled?: boolean }} [options]
 * @returns {{ ok: true; state: ExtensionState; rule: ServiceRule; originPattern: string } | { ok: false; error: string }}
 */
export function upsertServiceRule(state, rawServiceInput, options = {}) {
  const parsed = normalizeServiceInput(rawServiceInput, {
    keepPath: options.keepPath ?? true,
    customLabel: options.customLabel,
  });

  if (!parsed.ok) {
    return parsed;
  }

  const nextServices = state.services.map((s) => ({ ...s }));
  const idx = nextServices.findIndex((s) => s.id === parsed.id);

  /** @type {ServiceRule} */
  let targetRule;

  if (idx >= 0) {
    targetRule = {
      ...nextServices[idx],
      enabled: options.enabled ?? true,
      ...(options.accountEmail !== undefined ? { accountEmail: options.accountEmail } : {}),
    };
    nextServices[idx] = targetRule;
  } else {
    targetRule = {
      id: parsed.id,
      label: parsed.label,
      host: parsed.host,
      pathPrefix: parsed.pathPrefix,
      enabled: options.enabled ?? true,
      accountEmail: options.accountEmail ?? null,
      custom: true,
    };
    nextServices.unshift(targetRule);
  }

  const nextState = sanitizeState({
    ...state,
    services: nextServices,
  });
  const savedRule = nextState.services.find((s) => s.id === parsed.id) || targetRule;

  return {
    ok: true,
    state: nextState,
    rule: savedRule,
    originPattern: parsed.originPattern,
  };
}

/**
 * Load per-tab session records from `browser.storage.session` (survives MV3 event page suspends).
 * @returns {Promise<Record<string, TabSessionRecord & { redirectCount?: number }>>}
 */
export async function loadSessionTabs() {
  if (typeof browser !== "undefined" && browser?.storage?.session) {
    const res = await browser.storage.session.get(SESSION_TABS_KEY);
    const map = res[SESSION_TABS_KEY];
    if (map && typeof map === "object") {
      return /** @type {Record<string, TabSessionRecord & { redirectCount?: number }>} */ (map);
    }
  }
  return {};
}

/**
 * Save per-tab session records to `browser.storage.session`.
 * @param {Record<string, TabSessionRecord & { redirectCount?: number }>} tabMap
 * @returns {Promise<void>}
 */
export async function saveSessionTabs(tabMap) {
  if (typeof browser !== "undefined" && browser?.storage?.session) {
    await browser.storage.session.set({ [SESSION_TABS_KEY]: tabMap });
  }
}
