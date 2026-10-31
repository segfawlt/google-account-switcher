// @ts-check

import { SUB_APP_PRESETS, createInitialState } from "../core/constants.js";
import {
  removeAccountFromState,
  sanitizeState,
  upsertManualAccount,
  upsertServiceRule,
} from "../core/storage.js";
import { normalizeServiceInput } from "../core/url-rules.js";
import { h, replaceChildrenSafe } from "../ui/dom.js";
import {
  checkHostPermissionGranted,
  getInitialUiState,
  notifySyncCustomListeners,
  persistUiState,
  requestHostPermissionIfNeeded,
  subscribeToStateChanges,
  triggerAutoSyncAccounts,
  triggerGoogleImport,
} from "../ui/runtime-bridge.js";

/**
 * @typedef {import("../core/constants.js").ExtensionState} ExtensionState
 * @typedef {import("../core/constants.js").ThemePreference} ThemePreference
 * @typedef {import("../core/constants.js").AccountEntry} AccountEntry
 */

/** @type {ExtensionState} */
let currentState = createInitialState();
let filterQuery = "";

const sidebar = /** @type {HTMLElement} */ (document.getElementById("app-sidebar"));
const mobileMenuBtn = /** @type {HTMLButtonElement} */ (document.getElementById("mobile-menu-btn"));
const sidebarScopeText = /** @type {HTMLElement} */ (document.getElementById("sidebar-scope-text"));
const navAllowlistCount = /** @type {HTMLElement} */ (document.getElementById("nav-allowlist-count"));
const navAccountsCount = /** @type {HTMLElement} */ (document.getElementById("nav-accounts-count"));

const globalToggle = /** @type {HTMLInputElement} */ (document.getElementById("opt-global-toggle"));
const noticeBox = /** @type {HTMLElement} */ (document.getElementById("opt-notice"));
const noticeText = /** @type {HTMLElement} */ (document.getElementById("opt-notice-text"));
const noticeDismiss = /** @type {HTMLButtonElement} */ (document.getElementById("opt-notice-dismiss"));

const allowlistFindingLine = /** @type {HTMLElement} */ (document.getElementById("allowlist-finding-line"));
const defaultAccountSelect = /** @type {HTMLSelectElement} */ (
  document.getElementById("opt-default-account-select")
);
const addServiceForm = /** @type {HTMLFormElement} */ (document.getElementById("opt-add-service-form"));
const addServiceInput = /** @type {HTMLInputElement} */ (document.getElementById("opt-add-service-input"));
const subappPresetsEl = /** @type {HTMLElement} */ (document.getElementById("subapp-presets"));

const summaryEnabledCount = /** @type {HTMLElement} */ (document.getElementById("summary-enabled-count"));
const summaryCustomCount = /** @type {HTMLElement} */ (document.getElementById("summary-custom-count"));
const summaryOverrideCount = /** @type {HTMLElement} */ (document.getElementById("summary-override-count"));

const serviceSearch = /** @type {HTMLInputElement} */ (document.getElementById("opt-service-search"));
const serviceListEl = /** @type {HTMLElement} */ (document.getElementById("opt-service-list"));

const importBtn = /** @type {HTMLButtonElement} */ (document.getElementById("opt-import-btn"));
const accountsListEl = /** @type {HTMLElement} */ (document.getElementById("opt-accounts-list"));
const manualAccountForm = /** @type {HTMLFormElement} */ (
  document.getElementById("opt-manual-account-form")
);
const manualEmailInput = /** @type {HTMLInputElement} */ (document.getElementById("opt-manual-email"));
const manualSlotInput = /** @type {HTMLInputElement} */ (document.getElementById("opt-manual-slot"));

const exportJsonBtn = /** @type {HTMLButtonElement} */ (document.getElementById("export-json-btn"));
const importJsonInput = /** @type {HTMLInputElement} */ (document.getElementById("import-json-input"));
const resetBtn = /** @type {HTMLButtonElement} */ (document.getElementById("opt-reset-btn"));
const resetConfirmBtn = /** @type {HTMLButtonElement} */ (document.getElementById("opt-reset-confirm-btn"));
const resetCancelBtn = /** @type {HTMLButtonElement} */ (document.getElementById("opt-reset-cancel-btn"));

/**
 * Display inline status message.
 * @param {string} msg
 * @param {"neutral" | "error" | "warning"} [tone]
 */
function showNotice(msg, tone = "neutral") {
  noticeText.textContent = msg;
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
 * Switch active hash view (`#allowlist`, `#accounts`, `#backup`).
 */
function syncRouteView() {
  const rawHash = (window.location.hash || "#allowlist").slice(1);
  const activeView = ["allowlist", "accounts", "backup"].includes(rawHash) ? rawHash : "allowlist";

  for (const link of document.querySelectorAll("[data-view]")) {
    const viewName = link.getAttribute("data-view");
    if (viewName === activeView) {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
  }

  for (const panel of document.querySelectorAll("[data-view-panel]")) {
    const panelEl = /** @type {HTMLElement} */ (panel);
    panelEl.hidden = panelEl.getAttribute("data-view-panel") !== activeView;
  }

  sidebar.classList.remove("is-open");
}

/**
 * Format an account option label.
 * @param {AccountEntry} acc
 */
function formatAccountOption(acc) {
  return acc.index !== null ? `u/${acc.index} · ${acc.email}` : acc.email;
}

async function renderServicesPanel(
  /** @type {AccountEntry[]} */ visibleAccounts,
  /** @type {AccountEntry | null} */ defaultAcc
) {
  const enabledRules = currentState.services.filter((s) => s.enabled);
  const customRules = currentState.services.filter((s) => s.custom);
  const overrideRules = enabledRules.filter((s) => Boolean(s.accountEmail));

  summaryEnabledCount.textContent = String(enabledRules.length);
  summaryCustomCount.textContent = String(customRules.length);
  summaryOverrideCount.textContent = String(overrideRules.length);

  if (!currentState.redirectEnabled) {
    allowlistFindingLine.textContent =
      "Global redirect is currently paused. Re-enable it in the sidebar when ready.";
  } else if (visibleAccounts.length === 0) {
    allowlistFindingLine.textContent =
      "No Google accounts imported yet — switch to Google accounts in the sidebar to import your Firefox session.";
  } else {
    allowlistFindingLine.textContent = `${enabledRules.length} of ${currentState.services.length} services active · Default target: ${defaultAcc ? formatAccountOption(defaultAcc) : "None"}`;
  }

  // Render quick sub-app presets
  const presetNodes = SUB_APP_PRESETS.map((preset) => {
    const alreadyAdded = currentState.services.some((s) => s.id === preset.id);
    const btn = h(
      "button",
      {
        type: "button",
        className: "preset-btn",
        disabled: alreadyAdded,
      },
      [alreadyAdded ? `${preset.label} (added)` : `+ ${preset.label}`]
    );
    btn.addEventListener("click", async () => {
      const res = upsertServiceRule(currentState, preset.id, {
        keepPath: true,
        customLabel: preset.label,
        enabled: true,
      });
      if (res.ok) {
        currentState = await persistUiState(res.state);
        await renderAll();
      }
    });
    return btn;
  });
  replaceChildrenSafe(subappPresetsEl, ...presetNodes);

  const q = filterQuery.trim().toLowerCase();
  const filtered = currentState.services.filter((svc) => {
    if (!q) return true;
    return svc.label.toLowerCase().includes(q) || svc.id.toLowerCase().includes(q);
  });

  if (filtered.length === 0) {
    replaceChildrenSafe(
      serviceListEl,
      h("div", { className: "empty-frame" }, [
        h("span", {}, [`No services match "${filterQuery.trim()}".`]),
      ])
    );
    return;
  }

  const defaultSuffix = defaultAcc
    ? defaultAcc.index !== null
      ? ` (u/${defaultAcc.index} · ${defaultAcc.email})`
      : ` (${defaultAcc.email})`
    : " (not set)";

  const rowElements = await Promise.all(
    filtered.map(async (svc) => {
      const hasPerm = svc.enabled ? await checkHostPermissionGranted(svc.host) : true;

      const selectEl = h("select", {
        className: "select select-compact",
        "aria-label": `Target account for ${svc.label}`,
      });
      const opts = [
        h("option", { value: "" }, [`Default${defaultSuffix}`]),
        ...visibleAccounts.map((acc) => h("option", { value: acc.email }, [formatAccountOption(acc)])),
      ];
      replaceChildrenSafe(selectEl, ...opts);
      selectEl.value = svc.accountEmail || "";
      selectEl.disabled = !svc.enabled || visibleAccounts.length === 0;

      selectEl.addEventListener("change", async () => {
        const nextServices = currentState.services.map((item) =>
          item.id === svc.id ? { ...item, accountEmail: selectEl.value || null } : item
        );
        currentState = await persistUiState({ ...currentState, services: nextServices });
        await renderAll();
      });

      const toggleInput = h("input", {
        type: "checkbox",
        "aria-label": `Switch accounts automatically on ${svc.label}`,
      });
      toggleInput.checked = svc.enabled;
      toggleInput.addEventListener("change", () => {
        const want = toggleInput.checked;
        const originPattern = `https://${svc.host}/*`;
        const permPromise = want
          ? requestHostPermissionIfNeeded(svc.host, originPattern)
          : Promise.resolve(true);

        void (async () => {
          const granted = await permPromise;
          if (!granted) {
            toggleInput.checked = false;
            showNotice(`Host access for ${svc.host} was denied.`, "warning");
            return;
          }
          const nextServices = currentState.services.map((item) =>
            item.id === svc.id ? { ...item, enabled: want } : item
          );
          currentState = await persistUiState({ ...currentState, services: nextServices });
          await notifySyncCustomListeners();
          await renderAll();
        })();
      });

      let grantBtn = null;
      if (svc.enabled && !hasPerm) {
        grantBtn = h(
          "button",
          { type: "button", className: "btn", style: "height: 28px; font-size: 12px" },
          ["Grant access"]
        );
        grantBtn.addEventListener("click", () => {
          const permPromise = requestHostPermissionIfNeeded(svc.host, `https://${svc.host}/*`);
          void (async () => {
            const ok = await permPromise;
            if (ok) {
              await notifySyncCustomListeners();
              showNotice(`Granted host access for ${svc.host}.`);
              await renderAll();
            }
          })();
        });
      }

      let removeBtn = null;
      if (svc.custom) {
        removeBtn = h(
          "button",
          {
            type: "button",
            className: "btn-text-danger",
            "aria-label": `Remove custom service ${svc.id}`,
          },
          ["Remove"]
        );
        removeBtn.addEventListener("click", async () => {
          const nextServices = currentState.services.filter((item) => item.id !== svc.id);
          currentState = await persistUiState({ ...currentState, services: nextServices });
          await notifySyncCustomListeners();
          await renderAll();
        });
      }

      const showSubtitle = svc.label.toLowerCase() !== svc.id.toLowerCase();

      return h(
        "div",
        { className: svc.enabled ? "options-service-row" : "options-service-row is-disabled" },
        [
          h("div", { className: "service-info" }, [
            h("div", { className: "service-name-line" }, [
              h("span", { className: "service-name" }, [svc.label]),
              svc.custom ? h("span", { className: "pill" }, ["Custom"]) : null,
              svc.enabled && !hasPerm
                ? h("span", { className: "pill pill-warning" }, ["Needs host access"])
                : null,
              grantBtn,
              removeBtn,
            ]),
            showSubtitle ? h("span", { className: "service-domain" }, [svc.id]) : null,
          ]),
          selectEl,
          h("div", { className: "row-trailing" }, [
            h("label", { className: "switch" }, [
              toggleInput,
              h("span", { className: "switch-track" }),
            ]),
          ]),
        ]
      );
    })
  );

  replaceChildrenSafe(serviceListEl, ...rowElements);
}

function renderAccountsPanel(/** @type {AccountEntry[]} */ visibleAccounts) {
  if (visibleAccounts.length === 0) {
    replaceChildrenSafe(
      accountsListEl,
      h("div", { className: "empty-frame" }, [
        h("span", {}, [
          "No Google accounts saved yet. Sign into Google in Firefox and click Import from Google above.",
        ]),
      ])
    );
    return;
  }

  const rows = visibleAccounts.map((acc) => {
    const isDefault = acc.email === currentState.defaultAccountEmail;
    const removeBtn = h("button", { type: "button", className: "btn-text-danger" }, ["Remove"]);
    removeBtn.addEventListener("click", async () => {
      currentState = removeAccountFromState(currentState, acc.email);
      currentState = await persistUiState(currentState);
      await renderAll();
    });

    return h("div", { className: "account-row" }, [
      h("div", { className: "account-identity" }, [
        h("span", { className: "slot-code" }, [acc.index !== null ? `u/${acc.index}` : "mail"]),
        h("div", { className: "account-email-wrap" }, [
          h("div", { style: "display: flex; align-items: center; gap: 8px" }, [
            h("span", { className: "account-email" }, [acc.email]),
            isDefault ? h("span", { className: "pill pill-positive" }, ["Default"]) : null,
          ]),
          acc.name ? h("span", { className: "account-sub" }, [acc.name]) : null,
        ]),
      ]),
      removeBtn,
    ]);
  });

  replaceChildrenSafe(accountsListEl, h("div", { className: "account-list", style: "margin-top: 0; border-top: none" }, rows));
}

function renderThemeControls() {
  for (const btn of document.querySelectorAll("[data-theme-choice]")) {
    const choice = btn.getAttribute("data-theme-choice");
    btn.setAttribute("aria-pressed", String(choice === currentState.theme));
  }
}

async function renderAll() {
  globalToggle.checked = currentState.redirectEnabled;
  renderThemeControls();

  const visibleAccounts = currentState.accounts.filter((a) => !a.hidden);
  const defaultAcc =
    visibleAccounts.find((a) => a.email === currentState.defaultAccountEmail) ||
    visibleAccounts[0] ||
    null;

  const enabledCount = currentState.services.filter((s) => s.enabled).length;
  sidebarScopeText.textContent = `${enabledCount} active rule${enabledCount === 1 ? "" : "s"}`;
  navAllowlistCount.textContent = String(enabledCount);
  navAccountsCount.textContent = String(visibleAccounts.length);

  if (visibleAccounts.length === 0) {
    replaceChildrenSafe(
      defaultAccountSelect,
      h("option", { value: "" }, ["Import or add a Google account first"])
    );
    defaultAccountSelect.disabled = true;
  } else {
    defaultAccountSelect.disabled = false;
    replaceChildrenSafe(
      defaultAccountSelect,
      ...visibleAccounts.map((acc) => h("option", { value: acc.email }, [formatAccountOption(acc)]))
    );
    defaultAccountSelect.value = defaultAcc ? defaultAcc.email : visibleAccounts[0].email;
  }

  await renderServicesPanel(visibleAccounts, defaultAcc);
  renderAccountsPanel(visibleAccounts);
}

// ============================================================================
// Event Listeners
// ============================================================================

window.addEventListener("hashchange", syncRouteView);

mobileMenuBtn.addEventListener("click", () => {
  sidebar.classList.toggle("is-open");
});

noticeDismiss.addEventListener("click", hideNotice);

globalToggle.addEventListener("change", async () => {
  currentState = await persistUiState({
    ...currentState,
    redirectEnabled: globalToggle.checked,
  });
  await renderAll();
});

defaultAccountSelect.addEventListener("change", async () => {
  currentState = await persistUiState({
    ...currentState,
    defaultAccountEmail: defaultAccountSelect.value || null,
  });
  await renderAll();
});

serviceSearch.addEventListener("input", () => {
  filterQuery = serviceSearch.value;
  const visibleAccounts = currentState.accounts.filter((a) => !a.hidden);
  const defaultAcc =
    visibleAccounts.find((a) => a.email === currentState.defaultAccountEmail) ||
    visibleAccounts[0] ||
    null;
  void renderServicesPanel(visibleAccounts, defaultAcc);
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

  const permPromise = requestHostPermissionIfNeeded(parsed.host, parsed.originPattern);
  void (async () => {
    const granted = await permPromise;
    if (!granted) {
      showNotice(`Host permission for ${parsed.host} was not granted.`, "warning");
      return;
    }
    const res = upsertServiceRule(currentState, raw, { keepPath: true, enabled: true });
    if (!res.ok) {
      showNotice(res.error, "error");
      return;
    }
    addServiceInput.value = "";
    currentState = await persistUiState(res.state);
    await notifySyncCustomListeners();
    showNotice(`Added and enabled ${res.rule.id}.`);
    await renderAll();
  })();
});

importBtn.addEventListener("click", async () => {
  hideNotice();
  importBtn.disabled = true;
  importBtn.textContent = "Syncing...";
  try {
    const res = await triggerGoogleImport();
    if (!res.ok) {
      showNotice(res.error, "error");
    } else if (res.importedCount === 0) {
      showNotice(
        "No signed-in Google accounts detected in Firefox. Sign in at accounts.google.com first.",
        "warning"
      );
    } else {
      currentState = res.state;
      showNotice(`Synced ${res.importedCount} Google account${res.importedCount === 1 ? "" : "s"}.`);
      await renderAll();
    }
  } finally {
    importBtn.disabled = false;
    importBtn.textContent = "Sync from Google";
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
  currentState = await persistUiState(res.state);
  showNotice("Saved Google account.");
  await renderAll();
});

exportJsonBtn.addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(currentState, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = h("a", {
    href: url,
    download: "google-account-switcher-backup.json",
  });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

importJsonInput.addEventListener("change", async () => {
  const file = importJsonInput.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    currentState = await persistUiState(sanitizeState(parsed));
    await notifySyncCustomListeners();
    showNotice("Restored settings from backup JSON.");
    await renderAll();
  } catch {
    showNotice("Invalid JSON backup file.", "error");
  } finally {
    importJsonInput.value = "";
  }
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
  showNotice("All settings have been reset.");
  await renderAll();
});

subscribeToStateChanges((nextState) => {
  currentState = nextState;
  void renderAll();
});

async function bootstrap() {
  syncRouteView();
  currentState = await getInitialUiState();
  await renderAll();

  const hasVisibleAccounts = currentState.accounts.some((a) => !a.hidden);
  const syncRes = await triggerAutoSyncAccounts(!hasVisibleAccounts);
  if (syncRes.ok && !syncRes.skipped && syncRes.state) {
    currentState = syncRes.state;
    await renderAll();
  }
}

void bootstrap();
