// @ts-check

import {
  BOUNCE_COOLDOWN_MS,
  EXCLUDED_HOSTS,
  EXCLUDED_HOST_SUFFIXES,
  EXCLUDED_PATH_PREFIXES,
  SUB_APP_PRESETS,
} from "./constants.js";

/**
 * @typedef {import("./constants.js").AccountEntry} AccountEntry
 * @typedef {import("./constants.js").ServiceRule} ServiceRule
 * @typedef {import("./constants.js").ExtensionState} ExtensionState
 * @typedef {import("./constants.js").TabSessionRecord} TabSessionRecord
 */

/**
 * @typedef {Object} ExtractedUrlAccount
 * @property {"path" | "query-index" | "query-email"} kind
 * @property {number | string} value
 * @property {string} raw
 */

const PATH_ACCOUNT_RE = /\/u\/(\d+)(?=\/|$)/;
const LEADING_PATH_ACCOUNT_RE = /^\/u\/\d+(?=\/|$)/;
const FAST_LOOP_GUARD_MS = 5000;

/**
 * Normalize a hostname by lowercasing, stripping trailing dot, and removing leading "www.".
 * @param {string} hostname
 * @returns {string}
 */
export function normalizeHost(hostname) {
  let clean = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (clean.startsWith("www.") && clean.length > 4) {
    clean = clean.slice(4);
  }
  return clean;
}

/**
 * Strip `/u/<digit>` segments and trailing slashes from a path prefix.
 * @param {string} rawPath
 * @returns {string}
 */
export function normalizePathPrefix(rawPath) {
  if (!rawPath || rawPath === "/") return "";
  let cleaned = rawPath
    .trim()
    .replace(PATH_ACCOUNT_RE, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "");
  if (!cleaned || cleaned === "/") return "";
  if (!cleaned.startsWith("/")) {
    cleaned = `/${cleaned}`;
  }
  return cleaned;
}

/**
 * Parse and validate user service input or tab URL into a normalized ServiceRule descriptor.
 * @param {string} rawInput
 * @param {{ keepPath?: boolean; customLabel?: string }} [options]
 * @returns {{ ok: true; id: string; host: string; pathPrefix: string; label: string; originPattern: string } | { ok: false; error: string }}
 */
export function normalizeServiceInput(rawInput, options = {}) {
  const keepPath = options.keepPath ?? true;
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return { ok: false, error: "Enter a domain such as antigravity.google.com." };
  }

  let wildcardPrefix = false;
  let candidate = trimmed;

  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)) {
    if (candidate.startsWith("*.")) {
      wildcardPrefix = true;
      candidate = candidate.slice(2);
    }
    candidate = `https://${candidate}`;
  }

  /** @type {URL} */
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, error: "Invalid domain or URL format." };
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, error: "Only web domains (https://) can be managed." };
  }

  const baseHost = normalizeHost(parsed.hostname);
  if (!baseHost || !baseHost.includes(".") || /^\d+(\.\d+){3}$/.test(baseHost) || baseHost === "localhost") {
    return { ok: false, error: "Enter a valid domain name (for example, antigravity.google.com)." };
  }

  if (EXCLUDED_HOSTS.has(baseHost) || EXCLUDED_HOST_SUFFIXES.some((s) => baseHost.endsWith(s))) {
    return {
      ok: false,
      error: `${baseHost} handles Google sign-in or static assets and cannot be redirected safely.`,
    };
  }

  const host = wildcardPrefix ? `*.${baseHost}` : baseHost;
  const pathPrefix = keepPath ? normalizePathPrefix(parsed.pathname) : "";
  const id = `${host}${pathPrefix}`;

  const preset = SUB_APP_PRESETS.find((p) => p.id === id);
  const label = options.customLabel?.trim() || preset?.label || id;
  const originPattern = wildcardPrefix ? `https://*.${baseHost}/*` : `https://${baseHost}/*`;

  return {
    ok: true,
    id,
    host,
    pathPrefix,
    label,
    originPattern,
  };
}

/**
 * Check whether a host is already covered by the built-in `https://*.google.com/*` permission.
 * @param {string} host
 * @returns {boolean}
 */
export function isCoveredByBuiltinPermissions(host) {
  const bare = host.startsWith("*.") ? host.slice(2) : host;
  return bare === "google.com" || bare.endsWith(".google.com");
}

/**
 * Determine if a URL is a sensitive authentication, OAuth, logout, or download endpoint.
 * @param {URL} url
 * @returns {boolean}
 */
export function isExcludedUrl(url) {
  const rawHost = url.hostname.toLowerCase();
  const normHost = normalizeHost(rawHost);

  if (EXCLUDED_HOSTS.has(rawHost) || EXCLUDED_HOSTS.has(normHost)) {
    return true;
  }
  if (EXCLUDED_HOST_SUFFIXES.some((suffix) => rawHost.endsWith(suffix))) {
    return true;
  }

  const lowerPath = url.pathname.toLowerCase();
  for (const prefix of EXCLUDED_PATH_PREFIXES) {
    if (lowerPath === prefix || lowerPath.startsWith(`${prefix}/`)) {
      return true;
    }
  }

  // Never rewrite direct file download endpoints (e.g. Google Drive /uc?export=download)
  if ((lowerPath === "/uc" || lowerPath.endsWith("/uc")) && url.searchParams.get("export") === "download") {
    return true;
  }

  return false;
}

/**
 * Check if a URL matches a single ServiceRule (ignoring `rule.enabled`).
 * @param {URL} url
 * @param {ServiceRule} rule
 * @returns {boolean}
 */
export function doesUrlMatchRule(url, rule) {
  const normHost = normalizeHost(url.hostname);
  const ruleHost = rule.host.toLowerCase();

  let hostMatches = false;
  if (ruleHost.startsWith("*.")) {
    const suffix = ruleHost.slice(2);
    hostMatches = normHost === suffix || normHost.endsWith(`.${suffix}`);
  } else {
    hostMatches = normHost === normalizeHost(ruleHost);
  }

  if (!hostMatches) return false;
  if (!rule.pathPrefix) return true;

  const prefix = rule.pathPrefix.toLowerCase();
  const rawPath = url.pathname.toLowerCase();
  const strippedPath = rawPath.replace(LEADING_PATH_ACCOUNT_RE, "") || "/";

  return (
    rawPath === prefix ||
    rawPath.startsWith(`${prefix}/`) ||
    strippedPath === prefix ||
    strippedPath.startsWith(`${prefix}/`)
  );
}

/**
 * Match a URL against enabled service rules, returning the most specific match.
 * Also supports matching disabled rules when `includeDisabled` is true (for UI tab inspection).
 * @param {URL} url
 * @param {ReadonlyArray<ServiceRule>} rules
 * @param {{ includeDisabled?: boolean }} [options]
 * @returns {ServiceRule | null}
 */
export function matchServiceRule(url, rules, options = {}) {
  const includeDisabled = options.includeDisabled ?? false;
  /** @type {ServiceRule[]} */
  const candidates = [];

  for (const rule of rules) {
    if (!includeDisabled && !rule.enabled) continue;
    if (doesUrlMatchRule(url, rule)) {
      candidates.push(rule);
    }
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    // When inspecting UI rules, prefer enabled rules if specificity ties
    const aWildcard = a.host.startsWith("*.");
    const bWildcard = b.host.startsWith("*.");
    if (aWildcard !== bWildcard) return aWildcard ? 1 : -1;

    if (b.pathPrefix.length !== a.pathPrefix.length) {
      return b.pathPrefix.length - a.pathPrefix.length;
    }
    if (b.host.length !== a.host.length) {
      return b.host.length - a.host.length;
    }
    if (a.enabled !== b.enabled) {
      return a.enabled ? -1 : 1;
    }
    return 0;
  });

  return candidates[0];
}

/**
 * Extract any explicit Google account indicator (`/u/N` or `?authuser=...`) from a URL.
 * @param {URL} url
 * @returns {ExtractedUrlAccount | null}
 */
export function extractUrlAccount(url) {
  const pathMatch = url.pathname.match(PATH_ACCOUNT_RE);
  if (pathMatch) {
    return {
      kind: "path",
      value: Number(pathMatch[1]),
      raw: pathMatch[1],
    };
  }

  const authuser = url.searchParams.get("authuser");
  if (authuser !== null && authuser.trim() !== "") {
    const clean = authuser.trim();
    if (/^\d+$/.test(clean)) {
      return {
        kind: "query-index",
        value: Number(clean),
        raw: clean,
      };
    }
    if (clean.includes("@")) {
      return {
        kind: "query-email",
        value: clean.toLowerCase(),
        raw: clean,
      };
    }
  }

  return null;
}

/**
 * Check whether an extracted URL account indicator already points to `targetAccount`.
 * @param {ExtractedUrlAccount | null} extracted
 * @param {AccountEntry} targetAccount
 * @returns {boolean}
 */
export function urlAlreadyMatchesAccount(extracted, targetAccount) {
  if (!extracted) return false;
  if (extracted.kind === "path" || extracted.kind === "query-index") {
    return targetAccount.index !== null && extracted.value === targetAccount.index;
  }
  return extracted.value === targetAccount.email.toLowerCase();
}

/**
 * Rewrite a Google service URL to target `targetAccount` cleanly without path/query conflicts.
 * @param {URL} url
 * @param {AccountEntry} targetAccount
 * @returns {string}
 */
export function buildRedirectUrl(url, targetAccount) {
  const next = new URL(url.toString());

  if (PATH_ACCOUNT_RE.test(next.pathname)) {
    if (targetAccount.index !== null) {
      next.pathname = next.pathname.replace(PATH_ACCOUNT_RE, `/u/${targetAccount.index}`);
      // Prevent `/u/4/?authuser=0` conflicts that trigger server redirect loops
      next.searchParams.delete("authuser");
      return next.toString();
    }
    // Fallback when account was added manually by email without a synced numeric index
    next.pathname = next.pathname.replace(PATH_ACCOUNT_RE, "") || "/";
    next.searchParams.set("authuser", targetAccount.email);
    return next.toString();
  }

  const paramValue = targetAccount.index !== null ? String(targetAccount.index) : targetAccount.email;
  next.searchParams.set("authuser", paramValue);
  return next.toString();
}

/**
 * Resolve the effective AccountEntry for a matched ServiceRule.
 * @param {ServiceRule} rule
 * @param {ExtensionState} state
 * @returns {AccountEntry | null}
 */
export function resolveTargetAccount(rule, state) {
  const targetEmail = (rule.accountEmail || state.defaultAccountEmail || "").trim().toLowerCase();
  if (!targetEmail) return null;

  return (
    state.accounts.find((acc) => !acc.hidden && acc.email.toLowerCase() === targetEmail) || null
  );
}

/**
 * Detect whether a navigation was explicitly triggered by the user switching accounts
 * in Google's top-right avatar widget (`ogs.google.com` / `AccountChooser`) or inside an active tab.
 * @param {{ url: URL; originUrlString?: string; matchedRule: ServiceRule; tabRecord?: TabSessionRecord; targetAccount: AccountEntry; extracted: ExtractedUrlAccount | null }} ctx
 * @returns {boolean}
 */
export function isManualAvatarSwitch(ctx) {
  const { url, originUrlString, matchedRule, tabRecord, targetAccount, extracted } = ctx;
  if (!extracted || urlAlreadyMatchesAccount(extracted, targetAccount)) {
    return false;
  }

  if (!originUrlString) return false;

  /** @type {URL} */
  let originUrl;
  try {
    originUrl = new URL(originUrlString);
  } catch {
    return false;
  }

  const originHost = originUrl.hostname.toLowerCase();
  const originPath = originUrl.pathname.toLowerCase();

  // 1. Direct click inside Google's One Google Bar account picker iframe (`ogs.google.com`)
  // or Google's AccountChooser / SignOutOptions page
  if (
    originHost === "ogs.google.com" ||
    (originHost === "accounts.google.com" &&
      (originPath.startsWith("/accountchooser") || originPath.startsWith("/signoutoptions")))
  ) {
    return true;
  }

  // 2. Same-host navigation inside a tab that was ALREADY active on this managed service,
  // where the destination explicitly requests a different `/u/k` or `?authuser=k`
  // (excluding fast automatic server bounces right after our own redirect).
  if (
    normalizeHost(originUrl.hostname) === normalizeHost(url.hostname) &&
    tabRecord?.ruleId === matchedRule.id &&
    tabRecord.enforcedTarget !== undefined &&
    tabRecord.enforcedTarget !== null
  ) {
    return true;
  }

  return false;
}

/**
 * Pure decision engine for `webRequest.onBeforeRequest` navigations.
 * @param {{
 *   urlString: string;
 *   method: string;
 *   resourceType: string;
 *   tabId: number;
 *   originUrlString?: string;
 *   state: ExtensionState;
 *   tabRecord?: TabSessionRecord & { redirectCount?: number };
 *   now?: number;
 * }} input
 * @returns {{
 *   action: "allow" | "redirect";
 *   redirectUrl?: string;
 *   matchedRule?: ServiceRule;
 *   targetAccount?: AccountEntry;
 *   nextTabRecord?: TabSessionRecord & { redirectCount?: number };
 * }}
 */
export function evaluateNavigationRequest(input) {
  const {
    urlString,
    method,
    resourceType,
    tabId,
    originUrlString,
    state,
    tabRecord,
    now = Date.now(),
  } = input;

  if (resourceType !== "main_frame" || method.toUpperCase() !== "GET" || tabId < 0) {
    return { action: "allow" };
  }

  /** @type {URL} */
  let url;
  try {
    url = new URL(urlString);
  } catch {
    return { action: "allow" };
  }

  if (url.protocol !== "https:") {
    return { action: "allow" };
  }

  if (!state.redirectEnabled || tabRecord?.paused) {
    return { action: "allow" };
  }

  if (isExcludedUrl(url)) {
    return { action: "allow" };
  }

  const matchedRule = matchServiceRule(url, state.services);
  if (!matchedRule) {
    if (tabRecord?.ruleId) {
      return {
        action: "allow",
        nextTabRecord: {
          paused: Boolean(tabRecord.paused),
        },
      };
    }
    return { action: "allow" };
  }

  const targetAccount = resolveTargetAccount(matchedRule, state);
  if (!targetAccount) {
    return { action: "allow" };
  }

  const extracted = extractUrlAccount(url);
  const recentDelta =
    tabRecord?.ruleId === matchedRule.id && tabRecord.lastEnforcedAt
      ? now - tabRecord.lastEnforcedAt
      : Infinity;

  // Only treat same-host `/u/k` as manual switch if it isn't an immediate server 302 bounce (< 1.5s)
  const canBeSameHostManual = recentDelta > 1500;
  if (
    isManualAvatarSwitch({
      url,
      originUrlString,
      matchedRule,
      tabRecord: canBeSameHostManual ? tabRecord : undefined,
      targetAccount,
      extracted,
    }) &&
    extracted
  ) {
    return {
      action: "allow",
      nextTabRecord: {
        ...tabRecord,
        ruleId: matchedRule.id,
        host: normalizeHost(url.hostname),
        manualOverrideAccount: extracted.value,
      },
    };
  }

  // Respect an existing manual override in this tab unless the user switched back to the target account
  if (
    tabRecord?.ruleId === matchedRule.id &&
    tabRecord.manualOverrideAccount !== null &&
    tabRecord.manualOverrideAccount !== undefined
  ) {
    if (extracted && urlAlreadyMatchesAccount(extracted, targetAccount)) {
      return {
        action: "allow",
        nextTabRecord: {
          ...tabRecord,
          ruleId: matchedRule.id,
          host: normalizeHost(url.hostname),
          enforcedTarget: targetAccount.index ?? targetAccount.email,
          manualOverrideAccount: null,
          redirectCount: 0,
        },
      };
    }
    return { action: "allow" };
  }

  // Already routed to the desired account
  if (urlAlreadyMatchesAccount(extracted, targetAccount)) {
    return {
      action: "allow",
      nextTabRecord: {
        ...tabRecord,
        ruleId: matchedRule.id,
        host: normalizeHost(url.hostname),
        enforcedTarget: targetAccount.index ?? targetAccount.email,
        manualOverrideAccount: null,
        redirectCount: 0,
      },
    };
  }

  // Loop Guard 1: SPA consumed `?authuser=N`, set cookie, and 302-redirected back to clean URL (`extracted === null`)
  if (recentDelta < BOUNCE_COOLDOWN_MS && extracted === null) {
    return {
      action: "allow",
      nextTabRecord: {
        ...tabRecord,
        ruleId: matchedRule.id,
        host: normalizeHost(url.hostname),
        enforcedTarget: targetAccount.index ?? targetAccount.email,
      },
    };
  }

  // Loop Guard 2: Server rejected target index (e.g. user signed out of slot 4) and bounced back to `/u/0` repeatedly
  const prevCount = recentDelta < FAST_LOOP_GUARD_MS ? tabRecord?.redirectCount ?? 0 : 0;
  if (prevCount >= 2) {
    return {
      action: "allow",
      nextTabRecord: {
        ...tabRecord,
        ruleId: matchedRule.id,
        host: normalizeHost(url.hostname),
      },
    };
  }

  const redirectUrl = buildRedirectUrl(url, targetAccount);
  if (redirectUrl === urlString) {
    return { action: "allow" };
  }

  return {
    action: "redirect",
    redirectUrl,
    matchedRule,
    targetAccount,
    nextTabRecord: {
      paused: Boolean(tabRecord?.paused),
      ruleId: matchedRule.id,
      host: normalizeHost(url.hostname),
      lastEnforcedAt: now,
      enforcedTarget: targetAccount.index ?? targetAccount.email,
      manualOverrideAccount: null,
      redirectCount: prevCount + 1,
    },
  };
}
