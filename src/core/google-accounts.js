// @ts-check

/**
 * @typedef {import("./constants.js").AccountEntry} AccountEntry
 */

export const LIST_ACCOUNTS_URL =
  "https://accounts.google.com/ListAccounts?gpsia=1&source=ChromiumBrowser&json=standard";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Strip Google's XSSI protection prefix (`)]}'`) from a JSON response body.
 * @param {string} rawText
 * @returns {string}
 */
export function stripXssiPrefix(rawText) {
  return rawText.replace(/^\)\]\}'[^\n]*\n?/, "").trim();
}

/**
 * Parse Google's `ListAccounts?json=standard` payload (`["gaia.l.a.r", [ ... ]]`)
 * into ordered active `AccountEntry` records with exact `u/<index>` session slots.
 *
 * Handles both Chromium's canonical `["gaia.l.a", valid, name, email, photo, ..., signedOut]`
 * tuple (`gaia_auth_util.cc`) and fallback tuple layouts where email sits at index 0.
 *
 * @param {string} rawText
 * @returns {AccountEntry[]}
 */
export function parseListAccountsResponse(rawText) {
  const cleaned = stripXssiPrefix(rawText);
  if (!cleaned) {
    throw new Error("Empty response from Google ListAccounts.");
  }

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error("Unexpected non-JSON response from Google ListAccounts.");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Malformed ListAccounts payload.");
  }

  // Locate the array of account tuples (typically `parsed[1]`)
  const rawList = Array.isArray(parsed[1]) ? parsed[1] : parsed;
  // Unwrap single nested wrapper `[[["user@gmail.com", ...]]]` if present
  const rows =
    rawList.length === 1 &&
    Array.isArray(rawList[0]) &&
    Array.isArray(rawList[0][0])
      ? rawList[0]
      : rawList;

  /** @type {AccountEntry[]} */
  const results = [];
  const seenEmails = new Set();
  let activeSlotIndex = 0;

  for (const row of rows) {
    if (!Array.isArray(row) || row.length === 0) continue;

    /** @type {string | null} */
    let email = null;
    /** @type {string | undefined} */
    let name;
    /** @type {string | undefined} */
    let avatar;
    let signedOut = false;

    if (row[0] === "gaia.l.a") {
      // Canonical Chromium `gaia_auth_util.cc` layout:
      // [0]="gaia.l.a", [1]=valid, [2]=displayName, [3]=email, [4]=photoUrl, ..., [14]=signedOut
      if (typeof row[3] === "string" && EMAIL_RE.test(row[3].trim())) {
        email = row[3].trim().toLowerCase();
      }
      if (typeof row[2] === "string" && row[2].trim()) {
        name = row[2].trim();
      }
      if (typeof row[4] === "string" && row[4].startsWith("http")) {
        avatar = row[4];
      }
      if (row.length > 14 && Number(row[14]) === 1) {
        signedOut = true;
      }
    } else {
      // Fallback tuple layout: e.g. ["user@gmail.com", gaiaId, "Full Name", "https://lh3...", ...]
      for (const cell of row) {
        if (typeof cell === "string" && EMAIL_RE.test(cell.trim())) {
          email = cell.trim().toLowerCase();
          break;
        }
      }
      for (const cell of row) {
        if (typeof cell === "string" && cell.startsWith("https://")) {
          avatar = cell;
          break;
        }
      }
      if (typeof row[2] === "string" && !EMAIL_RE.test(row[2]) && !row[2].startsWith("http")) {
        name = row[2].trim();
      }
    }

    if (!email || signedOut) continue;

    if (seenEmails.has(email)) continue;
    seenEmails.add(email);

    results.push({
      email,
      index: activeSlotIndex,
      ...(name ? { name } : {}),
      ...(avatar ? { avatar } : {}),
      hidden: false,
    });
    activeSlotIndex += 1;
  }

  return results;
}

/**
 * Merge newly imported Google session accounts into existing stored accounts.
 * Preserves manual email-only entries (marking their `index: null` if not currently signed in)
 * and keeps real `u/<index>` numbers intact even when other accounts are hidden/removed.
 *
 * @param {ReadonlyArray<AccountEntry>} existing
 * @param {ReadonlyArray<AccountEntry>} imported
 * @param {{ revealHidden?: boolean }} [options]
 * @returns {AccountEntry[]}
 */
export function mergeImportedAccounts(existing, imported, options = {}) {
  const revealHidden = options.revealHidden ?? true;
  const existingByEmail = new Map(
    existing.map((acc) => [acc.email.toLowerCase(), acc])
  );
  const importedByEmail = new Map(
    imported.map((acc) => [acc.email.toLowerCase(), acc])
  );

  /** @type {AccountEntry[]} */
  const merged = [];

  for (const imp of imported) {
    const prev = existingByEmail.get(imp.email.toLowerCase());
    merged.push({
      email: imp.email.toLowerCase(),
      index: imp.index,
      name: imp.name || prev?.name,
      avatar: imp.avatar || prev?.avatar,
      hidden: revealHidden ? false : Boolean(prev?.hidden),
    });
  }

  // Retain manually added accounts that weren't in the current active session
  for (const prev of existing) {
    const key = prev.email.toLowerCase();
    if (!importedByEmail.has(key) && !prev.hidden) {
      merged.push({
        ...prev,
        email: key,
        index: null,
      });
    }
  }

  return merged;
}

/**
 * Remove (hide or delete) an account WITHOUT shifting sibling `u/<index>` session numbers.
 * Imported accounts with an active numeric Google slot are marked `hidden: true` so their
 * slot index stays accurate; manual accounts without a slot are removed outright.
 *
 * @param {ReadonlyArray<AccountEntry>} accounts
 * @param {string} emailToRemove
 * @returns {AccountEntry[]}
 */
export function removeAccountPreservingIndices(accounts, emailToRemove) {
  const target = emailToRemove.trim().toLowerCase();
  /** @type {AccountEntry[]} */
  const next = [];

  for (const acc of accounts) {
    if (acc.email.toLowerCase() !== target) {
      next.push({ ...acc });
      continue;
    }
    if (acc.index !== null) {
      next.push({ ...acc, hidden: true });
    }
  }

  return next;
}

/**
 * Fetch active signed-in Google accounts from the current Firefox cookie jar.
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<AccountEntry[]>}
 */
export async function fetchGoogleAccounts(fetchImpl = fetch) {
  const attempts = [
    () =>
      fetchImpl(LIST_ACCOUNTS_URL, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        },
        body: " ",
      }),
    () =>
      fetchImpl("https://accounts.google.com/ListAccounts?gpsia=1&source=ogb&json=standard", {
        method: "GET",
        credentials: "include",
      }),
  ];

  /** @type {Error | null} */
  let lastError = null;

  for (const runAttempt of attempts) {
    try {
      const response = await runAttempt();
      if (!response.ok) {
        lastError = new Error(`Google responded with HTTP ${response.status}.`);
        continue;
      }
      const text = await response.text();
      const accounts = parseListAccountsResponse(text);
      if (accounts.length > 0) {
        return accounts;
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  if (lastError) {
    throw lastError;
  }
  return [];
}
