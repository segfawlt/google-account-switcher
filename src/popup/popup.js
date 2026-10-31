// @ts-check

import { createInitialState } from "../core/constants.js";
import {
  removeAccountFromState,
  upsertManualAccount,
  upsertServiceRule,
} from "../core/storage.js";
import {
  isExcludedUrl,
  matchServiceRule,
  normalizeHost,
  normalizeServiceInput,
  resolveTargetAccount,
} from "../core/url-rules.js";
import { h, replaceChildrenSafe } from "../ui/dom.js";
import {
  applyRuleToActiveTab,
  getInitialUiState,
  notifySyncCustomListeners,
  openFullOptionsPage,
  persistUiState,
  queryActiveTabInfo,
  requestHostPermissionIfNeeded,
  setActiveTabPaused,
  subscribeToStateChanges,
  triggerAutoSyncAccounts,
  triggerGoogleImport,
} from "../ui/runtime-bridge.js";

/**
 * @typedef {import("../core/constants.js").ExtensionState} ExtensionState
 * @typedef {import("../core/constants.js").ThemePreference} ThemePreference
 * @typedef {import("../core/constants.js").AccountEntry} AccountEntry
 * @typedef {import("../core/constants.js").ServiceRule} ServiceRule
 * @typedef {import("../ui/runtime-bridge.js").ActiveTabInfo} ActiveTabInfo
 */

/** @type {ExtensionState} */
let currentState = createInitialState();

/** @type {ActiveTabInfo | null} */
let activeTab = null;

let searchQuery = "";

const globalToggle = /** @type {HTMLInputElement} */ (document.getElementById("global-redirect-toggle"));
const noticeBox = /** @type {HTMLElement} */ (document.getElementById("popup-notice"));
const noticeText = /** @type {HTMLElement} */ (document.getElementById("popup-notice-text"));
const noticeDismiss = /** @type {HTMLButtonElement} */ (document.getElementById("popup-notice-dismiss"));

const currentTabBadge = /** @type {HTMLElement} */ (document.getElementById("current-tab-badge"));
const currentTabBody = /** @type {HTMLElement} */ (document.getElementById("current-tab-body"));

const defaultAccountSelect = /** @type {HTMLSelectElement} */ (document.getElementById("default-account-select"));
const defaultAccountSlot = /** @type {HTMLElement} */ (document.getElementById("default-account-slot"));

const allowedAppsCount = /** @type {HTMLElement} */ (document.getElementById("allowed-apps-count"));
const serviceSearchInput = /** @type {HTMLInputElement} */ (document.getElementById("service-search-input"));
const serviceListEl = /** @type {HTMLElement} */ (document.getElementById("service-list"));
const addServiceForm = /** @type {HTMLFormElement} */ (document.getElementById("add-service-form"));
const addServiceInput = /** @type {HTMLInputElement} */ (document.getElementById("add-service-input"));

const accountsCount = /** @type {HTMLElement} */ (document.getElementById("accounts-count"));
const importGoogleBtn = /** @type {HTMLButtonElement} */ (document.getElementById("import-google-btn"));
const toggleManualAccountBtn = /** @type {HTMLButtonElement} */ (
  document.getElementById("toggle-manual-account-btn")
);
const manualAccountForm = /** @type {HTMLFormElement} */ (document.getElementById("manual-account-form"));
const manualEmailInput = /** @type {HTMLInputElement} */ (document.getElementById("manual-email-input"));
const manualSlotInput = /** @type {HTMLInputElement} */ (document.getElementById("manual-slot-input"));
const accountListContainer = /** @type {HTMLElement} */ (document.getElementById("account-list-container"));

const openOptionsBtn = /** @type {HTMLButtonElement} */ (document.getElementById("open-options-btn"));
const resetBtn = /** @type {HTMLButtonElement} */ (document.getElementById("reset-btn"));
const resetConfirmBtn = /** @type {HTMLButtonElement} */ (document.getElementById("reset-confirm-btn"));
const resetCancelBtn = /** @type {HTMLButtonElement} */ (document.getElementById("reset-cancel-btn"));

/**
 * Show an inline notice without browser alert/confirm dialogs.
 * @param {string} message
 * @param {"neutral" | "error" | "warning"} [tone]
 */
function showNotice(message, tone = "neutral") {
  noticeText.textContent = message;
  noticeBox.className =
    tone === "error"
      ? "notice notice-error"
      : tone === "warning"
        ? "notice notice-warning"
        : "notice";
  noticeBox.hidden = false;
}

function hideNotice() {
  noticeBox.hidden = true;
}

/**
 * Format an account label with its `u/<index>` slot when known.
 * @param {AccountEntry} acc
 * @returns {string}
 */
function formatAccountOptionLabel(acc) {
  return acc.index !== null ? `u/${acc.index} · ${acc.email}` : acc.email;
}

/**
 * Build `<select>` options for a per-service account selector.
 * @param {HTMLSelectElement} selectEl
 * @param {string | null} selectedEmail
 * @param {AccountEntry[]} visibleAccounts
 * @param {AccountEntry | null} defaultAcc
 */
function populateServiceAccountSelect(selectEl, selectedEmail, visibleAccounts, defaultAcc) {
  const defaultSuffix = defaultAcc
    ? defaultAcc.index !== null
      ? ` (u/${defaultAcc.index})`
      : ` (${defaultAcc.email.split("@")[0]})`
    : " (not set)";

  const defaultOpt = h("option", { value: "" }, [`Default${defaultSuffix}`]);
  const options = [defaultOpt];

  for (const acc of visibleAccounts) {
    options.push(h("option", { value: acc.email }, [formatAccountOptionLabel(acc)]));
  }

  replaceChildrenSafe(selectEl, ...options);
  selectEl.value = selectedEmail || "";
}

/**
 * Render the Current Tab strip (1-click capture for unknown sites + active tab controls).
 * @param {AccountEntry[]} visibleAccounts
 * @param {AccountEntry | null} defaultAcc
 */
function renderCurrentTabStrip(visibleAccounts, defaultAcc) {
  if (!activeTab || !activeTab.url.startsWith("https://")) {
    currentTabBadge.className = "pill";
    currentTabBadge.textContent = "Browser tab";
    replaceChildrenSafe(
      currentTabBody,
      h("div", { className: "tab-status-text" }, [
        "Open any Google app (such as docs.google.com or antigravity.google.com) to capture or control it here.",
      ])
    );
    return;
  }

  /** @type {URL} */
  let tabUrl;
  try {
    tabUrl = new URL(activeTab.url);
  } catch {
    return;
  }

  const hostDisplay = normalizeHost(tabUrl.hostname);

  if (isExcludedUrl(tabUrl)) {
    currentTabBadge.className = "pill";
    currentTabBadge.textContent = "Protected";
    replaceChildrenSafe(
      currentTabBody,
      h("div", { className: "tab-host-group" }, [
        h("span", { className: "tab-host-name" }, [hostDisplay]),
        h("span", { className: "tab-status-text" }, [
          "Google sign-in and OAuth pages are left untouched so login never breaks.",
        ]),
      ])
    );
    return;
  }

  const enabledMatch = matchServiceRule(tabUrl, currentState.services);
  const anyMatch = matchServiceRule(tabUrl, currentState.services, { includeDisabled: true });

  // Case 1: Unlisted domain (e.g. antigravity.google.com) -> 1-click capture!
  if (!anyMatch) {
    currentTabBadge.className = "pill";
    currentTabBadge.textContent = "Not added";

    const addSiteBtn = h("button", { type: "button", className: "btn btn-primary" }, [
      "Add this tab",
    ]);
    addSiteBtn.addEventListener("click", () => {
      const parsed = normalizeServiceInput(tabUrl.toString(), { keepPath: false });
      if (!parsed.ok) {
        showNotice(parsed.error, "error");
        return;
      }
      // Request optional host permission synchronously in user-gesture stack if non-*.google.com
      const permPromise = requestHostPermissionIfNeeded(parsed.host, parsed.originPattern);
      void (async () => {
        const granted = await permPromise;
        if (!granted) {
          showNotice(`Host permission for ${parsed.host} was not granted.`, "warning");
          return;
        }
        const res = upsertServiceRule(currentState, tabUrl.toString(), {
          keepPath: false,
          enabled: true,
        });
        if (!res.ok) {
          showNotice(res.error, "error");
          return;
        }
        currentState = await persistUiState(res.state);
        await notifySyncCustomListeners();
        if (activeTab && currentState.redirectEnabled) {
          await applyRuleToActiveTab(activeTab.id);
        }
        renderAll();
      })();
    });

    replaceChildrenSafe(
      currentTabBody,
      h("div", { className: "tab-strip-top" }, [
        h("div", { className: "tab-host-group" }, [
          h("span", { className: "tab-host-name" }, [hostDisplay]),
          h("span", { className: "tab-status-text" }, [
            "Not added yet. Add this tab to switch accounts automatically.",
          ]),
        ]),
      ]),
      h("div", { className: "tab-strip-actions" }, [addSiteBtn])
    );
    return;
  }

  // Case 2: Listed in catalog, currently toggled OFF
  if (!enabledMatch) {
    currentTabBadge.className = "pill";
    currentTabBadge.textContent = "Off";

    const enableBtn = h("button", { type: "button", className: "btn btn-primary" }, [
      "Turn on for this tab",
    ]);
    enableBtn.addEventListener("click", async () => {
      const nextServices = currentState.services.map((s) =>
        s.id === anyMatch.id ? { ...s, enabled: true } : s
      );
      currentState = await persistUiState({ ...currentState, services: nextServices });
      if (activeTab && currentState.redirectEnabled) {
        await applyRuleToActiveTab(activeTab.id);
      }
      renderAll();
    });

    replaceChildrenSafe(
      currentTabBody,
      h("div", { className: "tab-host-group" }, [
        h("span", { className: "tab-host-name" }, [anyMatch.id]),
        h("span", { className: "tab-status-text" }, [
          "In your app list, currently turned off.",
        ]),
      ]),
      h("div", { className: "tab-strip-actions" }, [enableBtn])
    );
    return;
  }

  // Case 3: Active managed rule!
  const targetAcc = resolveTargetAccount(enabledMatch, currentState);
  const isTabPaused = Boolean(activeTab.tabRecord?.paused);
  const manualOverride =
    activeTab.tabRecord?.ruleId === enabledMatch.id
      ? activeTab.tabRecord.manualOverrideAccount
      : null;

  if (!currentState.redirectEnabled) {
    currentTabBadge.className = "pill";
    currentTabBadge.textContent = "Global off";
  } else if (isTabPaused) {
    currentTabBadge.className = "pill pill-warning";
    currentTabBadge.textContent = "Skipped";
  } else if (manualOverride !== null && manualOverride !== undefined) {
    currentTabBadge.className = "pill pill-warning";
    currentTabBadge.textContent =
      typeof manualOverride === "number" ? `Manual u/${manualOverride}` : "Manual switch";
  } else if (targetAcc) {
    currentTabBadge.className = "pill pill-positive";
    currentTabBadge.textContent =
      targetAcc.index !== null ? `Active · u/${targetAcc.index}` : "Active";
  } else {
    currentTabBadge.className = "pill pill-warning";
    currentTabBadge.textContent = "No account";
  }

  const inlineSelect = h("select", {
    className: "select select-compact",
    "aria-label": `Account for ${enabledMatch.label}`,
  });
  populateServiceAccountSelect(inlineSelect, enabledMatch.accountEmail, visibleAccounts, defaultAcc);
  inlineSelect.disabled = visibleAccounts.length === 0;
  inlineSelect.addEventListener("change", async () => {
    const val = inlineSelect.value || null;
    const nextServices = currentState.services.map((s) =>
      s.id === enabledMatch.id ? { ...s, accountEmail: val } : s
    );
    currentState = await persistUiState({ ...currentState, services: nextServices });
    if (activeTab && currentState.redirectEnabled) {
      await applyRuleToActiveTab(activeTab.id);
    }
    renderAll();
  });

  const isTemporarilySkipped =
    isTabPaused || (manualOverride !== null && manualOverride !== undefined);
  const pauseOrResumeLabel = isTemporarilySkipped ? "Resume rule" : "Skip this tab";

  const pauseBtn = h(
    "button",
    {
      type: "button",
      className: "btn",
      style: "height: 30px; font-size: 12px",
      title: isTemporarilySkipped
        ? "Re-apply your assigned Google account in this tab"
        : "Temporarily stop forcing an account in this tab only",
    },
    [pauseOrResumeLabel]
  );
  pauseBtn.addEventListener("click", async () => {
    if (!activeTab) return;
    const shouldPause = !isTemporarilySkipped;
    const updatedRec = await setActiveTabPaused(activeTab.id, shouldPause, !shouldPause);
    activeTab = { ...activeTab, tabRecord: updatedRec };
    renderAll();
  });

  const statusLine = !targetAcc
    ? "Sync or add a Google account below to start routing."
    : isTabPaused
      ? "Skipped in this tab only — other tabs still redirect."
      : manualOverride !== null && manualOverride !== undefined
        ? "Respecting your manual avatar switch in this tab."
        : `Assigned to ${targetAcc.email}`;

  replaceChildrenSafe(
    currentTabBody,
    h("div", { className: "tab-host-group" }, [
      h("span", { className: "tab-host-name" }, [enabledMatch.id]),
      h("span", { className: "tab-status-text" }, [statusLine]),
    ]),
    h("div", { className: "tab-strip-actions" }, [inlineSelect, pauseBtn])
  );
}

/**
 * Render Default Account dropdown.
 * @param {AccountEntry[]} visibleAccounts
 * @param {AccountEntry | null} defaultAcc
 */
function renderDefaultAccount(visibleAccounts, defaultAcc) {
  if (visibleAccounts.length === 0) {
    replaceChildrenSafe(
      defaultAccountSelect,
      h("option", { value: "" }, ["Import or add an account below first"])
    );
    defaultAccountSelect.disabled = true;
    defaultAccountSlot.textContent = "—";
    return;
  }

  defaultAccountSelect.disabled = false;
  const opts = visibleAccounts.map((acc) =>
    h("option", { value: acc.email }, [formatAccountOptionLabel(acc)])
  );
  replaceChildrenSafe(defaultAccountSelect, ...opts);
  defaultAccountSelect.value = defaultAcc ? defaultAcc.email : visibleAccounts[0].email;
  defaultAccountSlot.textContent =
    defaultAcc && defaultAcc.index !== null ? `Slot u/${defaultAcc.index}` : "";
}

/**
 * Render Allowed Apps list with search filter, per-app account dropdown, and allowlist toggle.
 * @param {AccountEntry[]} visibleAccounts
 * @param {AccountEntry | null} defaultAcc
 */
function renderServices(visibleAccounts, defaultAcc) {
  const enabledTotal = currentState.services.filter((s) => s.enabled).length;
  allowedAppsCount.textContent = `${enabledTotal} of ${currentState.services.length} on`;

  const q = searchQuery.trim().toLowerCase();
  const filtered = currentState.services.filter((svc) => {
    if (!q) return true;
    return svc.label.toLowerCase().includes(q) || svc.id.toLowerCase().includes(q);
  });

  if (filtered.length === 0) {
    replaceChildrenSafe(
      serviceListEl,
      h("div", { className: "empty-frame", style: "margin-top: 8px" }, [
        h("span", {}, [`No apps matching "${searchQuery.trim()}". Add it below as a custom domain.`]),
      ])
    );
    return;
  }

  const rows = filtered.map((svc) => {
    const accountSelect = h("select", {
      className: "select select-compact",
      "aria-label": `Account for ${svc.label}`,
    });
    populateServiceAccountSelect(accountSelect, svc.accountEmail, visibleAccounts, defaultAcc);
    accountSelect.disabled = !svc.enabled || visibleAccounts.length === 0;

    accountSelect.addEventListener("change", async () => {
      const val = accountSelect.value || null;
      const nextServices = currentState.services.map((item) =>
        item.id === svc.id ? { ...item, accountEmail: val } : item
      );
      currentState = await persistUiState({ ...currentState, services: nextServices });
      if (activeTab && activeTab.url.includes(svc.host) && currentState.redirectEnabled) {
        await applyRuleToActiveTab(activeTab.id);
      }
      renderAll();
    });

    const toggleInput = h("input", {
      type: "checkbox",
      "aria-label": `Switch accounts automatically on ${svc.label}`,
    });
    toggleInput.checked = svc.enabled;
    toggleInput.addEventListener("change", () => {
      const wantEnabled = toggleInput.checked;
      const originPattern = svc.host.startsWith("*.")
        ? `https://${svc.host}/*`
        : `https://${svc.host}/*`;
      const permPromise = wantEnabled
        ? requestHostPermissionIfNeeded(svc.host, originPattern)
        : Promise.resolve(true);

      void (async () => {
        const granted = await permPromise;
        if (!granted) {
          toggleInput.checked = false;
          showNotice(`Host permission for ${svc.host} is required to redirect it.`, "warning");
          return;
        }
        const nextServices = currentState.services.map((item) =>
          item.id === svc.id ? { ...item, enabled: wantEnabled } : item
        );
        currentState = await persistUiState({ ...currentState, services: nextServices });
        await notifySyncCustomListeners();
        if (wantEnabled && activeTab && activeTab.url.includes(svc.host) && currentState.redirectEnabled) {
          await applyRuleToActiveTab(activeTab.id);
        }
        renderAll();
      })();
    });

    let removeBtn = null;
    if (svc.custom) {
      removeBtn = h(
        "button",
        {
          type: "button",
          className: "icon-remove-btn",
          title: `Remove ${svc.id}`,
          "aria-label": `Remove custom rule ${svc.id}`,
        },
        ["×"]
      );
      removeBtn.addEventListener("click", async () => {
        const nextServices = currentState.services.filter((item) => item.id !== svc.id);
        currentState = await persistUiState({ ...currentState, services: nextServices });
        await notifySyncCustomListeners();
        renderAll();
      });
    }

    const showSubtitle = svc.label.toLowerCase() !== svc.id.toLowerCase();

    return h(
      "div",
      { className: svc.enabled ? "service-row" : "service-row is-disabled" },
      [
        h("div", { className: "service-info" }, [
          h("div", { className: "service-name-line" }, [
            h("span", { className: "service-name", title: svc.label }, [svc.label]),
            removeBtn,
          ]),
          showSubtitle
            ? h("span", { className: "service-domain", title: svc.id }, [svc.id])
            : null,
        ]),
        accountSelect,
        h("div", { className: "row-trailing" }, [
          h("label", { className: "switch" }, [
            toggleInput,
            h("span", { className: "switch-track" }),
          ]),
        ]),
      ]
    );
  });

  replaceChildrenSafe(serviceListEl, ...rows);
}

/**
 * Render saved/imported Google Accounts list.
 * @param {AccountEntry[]} visibleAccounts
 */
function renderAccounts(visibleAccounts) {
  accountsCount.textContent = `${visibleAccounts.length} active`;

  if (visibleAccounts.length === 0) {
    replaceChildrenSafe(
      accountListContainer,
      h("div", { className: "empty-frame", style: "margin-top: 8px" }, [
        h("span", {}, [
          "Sign into Google in Firefox, then click Import from Google to load your session slots.",
        ]),
      ])
    );
    return;
  }

  const rows = visibleAccounts.map((acc) => {
    const slotText = acc.index !== null ? `u/${acc.index}` : "mail";
    const removeBtn = h(
      "button",
      {
        type: "button",
        className: "btn-text-danger",
        "aria-label": `Remove ${acc.email}`,
      },
      ["Remove"]
    );
    removeBtn.addEventListener("click", async () => {
      currentState = removeAccountFromState(currentState, acc.email);
      currentState = await persistUiState(currentState);
      renderAll();
    });

    return h("div", { className: "account-row" }, [
      h("div", { className: "account-identity" }, [
        h("span", { className: "slot-code" }, [slotText]),
        h("div", { className: "account-email-wrap" }, [
          h("span", { className: "account-email", title: acc.email }, [acc.email]),
          acc.name ? h("span", { className: "account-sub" }, [acc.name]) : null,
        ]),
      ]),
      removeBtn,
    ]);
  });

  replaceChildrenSafe(accountListContainer, h("div", { className: "account-list" }, rows));
}

function renderThemeControls() {
  for (const btn of document.querySelectorAll("[data-theme-choice]")) {
    const choice = btn.getAttribute("data-theme-choice");
    btn.setAttribute("aria-pressed", String(choice === currentState.theme));
  }
}

function renderAll() {
  globalToggle.checked = currentState.redirectEnabled;
  renderThemeControls();

  const visibleAccounts = currentState.accounts.filter((a) => !a.hidden);
  const defaultAcc =
    visibleAccounts.find((a) => a.email === currentState.defaultAccountEmail) ||
    visibleAccounts[0] ||
    null;

  renderCurrentTabStrip(visibleAccounts, defaultAcc);
  renderDefaultAccount(visibleAccounts, defaultAcc);
  renderServices(visibleAccounts, defaultAcc);
  renderAccounts(visibleAccounts);
}

// ============================================================================
// Event Wire-Up
// ============================================================================

globalToggle.addEventListener("change", async () => {
  currentState = await persistUiState({
    ...currentState,
    redirectEnabled: globalToggle.checked,
  });
  renderAll();
});

noticeDismiss.addEventListener("click", hideNotice);

defaultAccountSelect.addEventListener("change", async () => {
  const email = defaultAccountSelect.value || null;
  currentState = await persistUiState({
    ...currentState,
    defaultAccountEmail: email,
  });
  if (activeTab && currentState.redirectEnabled) {
    await applyRuleToActiveTab(activeTab.id);
  }
  renderAll();
});

serviceSearchInput.addEventListener("input", () => {
  searchQuery = serviceSearchInput.value;
  const visibleAccounts = currentState.accounts.filter((a) => !a.hidden);
  const defaultAcc =
    visibleAccounts.find((a) => a.email === currentState.defaultAccountEmail) ||
    visibleAccounts[0] ||
    null;
  renderServices(visibleAccounts, defaultAcc);
});

addServiceForm.addEventListener("submit", (e) => {
  e.preventDefault();
  hideNotice();

  const raw = addServiceInput.value.trim();
  const parsed = normalizeServiceInput(raw, { keepPath: true });
  if (!parsed.ok) {
    showNotice(parsed.error, "error");
    return;
  }

  // Request optional host permission synchronously inside form submit gesture
  const permPromise = requestHostPermissionIfNeeded(parsed.host, parsed.originPattern);

  void (async () => {
    const granted = await permPromise;
    if (!granted) {
      showNotice(
        `Permission for ${parsed.host} was not granted. Open Full settings to grant host access.`,
        "warning"
      );
      return;
    }

    const res = upsertServiceRule(currentState, raw, { keepPath: true, enabled: true });
    if (!res.ok) {
      showNotice(res.error, "error");
      return;
    }

    addServiceInput.value = "";
    searchQuery = "";
    serviceSearchInput.value = "";
    currentState = await persistUiState(res.state);
    await notifySyncCustomListeners();

    if (activeTab && activeTab.url.includes(res.rule.host) && currentState.redirectEnabled) {
      await applyRuleToActiveTab(activeTab.id);
    }
    showNotice(`Added and enabled ${res.rule.id}.`);
    renderAll();
  })();
});

importGoogleBtn.addEventListener("click", async () => {
  hideNotice();
  importGoogleBtn.disabled = true;
  importGoogleBtn.textContent = "Syncing...";

  try {
    const res = await triggerGoogleImport();
    if (!res.ok) {
      showNotice(res.error, "error");
    } else if (res.importedCount === 0) {
      showNotice(
        "No active Google sessions found. Sign in at accounts.google.com first, or add an email manually.",
        "warning"
      );
    } else {
      currentState = res.state;
      showNotice(`Synced ${res.importedCount} Google account${res.importedCount === 1 ? "" : "s"}.`);
      renderAll();
    }
  } finally {
    importGoogleBtn.disabled = false;
    importGoogleBtn.textContent = "Sync from Google";
  }
});

toggleManualAccountBtn.addEventListener("click", () => {
  manualAccountForm.hidden = !manualAccountForm.hidden;
  if (!manualAccountForm.hidden) {
    manualEmailInput.focus();
  }
});

manualAccountForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  hideNotice();

  const rawSlot = manualSlotInput.value.trim();
  const slot = rawSlot === "" ? null : Number(rawSlot);
  const res = upsertManualAccount(currentState, manualEmailInput.value, slot);
  if (!res.ok) {
    showNotice(res.error, "error");
    return;
  }

  manualEmailInput.value = "";
  manualSlotInput.value = "";
  manualAccountForm.hidden = true;
  currentState = await persistUiState(res.state);
  renderAll();
});

openOptionsBtn.addEventListener("click", () => {
  void openFullOptionsPage();
});

resetBtn.addEventListener("click", () => {
  resetBtn.hidden = true;
  resetConfirmBtn.hidden = false;
  resetCancelBtn.hidden = false;
});

resetCancelBtn.addEventListener("click", () => {
  resetBtn.hidden = false;
  resetConfirmBtn.hidden = true;
  resetCancelBtn.hidden = true;
});

for (const btn of document.querySelectorAll("[data-theme-choice]")) {
  btn.addEventListener("click", async () => {
    const rawChoice = btn.getAttribute("data-theme-choice");
    /** @type {ThemePreference} */
    const nextTheme =
      rawChoice === "light" || rawChoice === "dark" ? rawChoice : "system";
    currentState = await persistUiState({ ...currentState, theme: nextTheme });
    renderThemeControls();
  });
}

resetConfirmBtn.addEventListener("click", async () => {
  currentState = await persistUiState({
    ...createInitialState(),
    theme: currentState.theme,
  });
  await notifySyncCustomListeners();
  resetBtn.hidden = false;
  resetConfirmBtn.hidden = true;
  resetCancelBtn.hidden = true;
  showNotice("All settings reset to defaults.");
  renderAll();
});

subscribeToStateChanges((nextState) => {
  currentState = nextState;
  renderAll();
});

async function bootstrap() {
  const [loadedState, tabInfo] = await Promise.all([getInitialUiState(), queryActiveTabInfo()]);
  currentState = loadedState;
  activeTab = tabInfo;
  renderAll();

  // First-open autoload if 0 accounts, or silent background refresh when cooldown (>2 min) elapsed
  const hasVisibleAccounts = currentState.accounts.some((a) => !a.hidden);
  if (!hasVisibleAccounts) {
    importGoogleBtn.textContent = "Checking Google...";
  }
  const syncRes = await triggerAutoSyncAccounts(!hasVisibleAccounts);
  if (!hasVisibleAccounts) {
    importGoogleBtn.textContent = "Sync from Google";
  }
  if (syncRes.ok && !syncRes.skipped && syncRes.state) {
    currentState = syncRes.state;
    renderAll();
  }
}

void bootstrap();
