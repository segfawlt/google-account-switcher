// @ts-check

/**
 * @typedef {Object} AccountEntry
 * @property {string} email
 * @property {number | null} index
 * @property {string} [name]
 * @property {string} [avatar]
 * @property {boolean} [hidden]
 */

/**
 * @typedef {Object} ServiceRule
 * @property {string} id
 * @property {string} label
 * @property {string} host
 * @property {string} pathPrefix
 * @property {boolean} enabled
 * @property {string | null} accountEmail - null means inherit Default Account
 * @property {boolean} custom
 */

/**
 * @typedef {"system" | "light" | "dark"} ThemePreference
 */

/**
 * @typedef {Object} ExtensionState
 * @property {number} version
 * @property {boolean} redirectEnabled
 * @property {ThemePreference} theme
 * @property {string | null} defaultAccountEmail
 * @property {AccountEntry[]} accounts
 * @property {ServiceRule[]} services
 * @property {number} [lastAccountSyncAt]
 */

/**
 * @typedef {Object} TabSessionRecord
 * @property {string} [ruleId]
 * @property {string} [host]
 * @property {number} [lastEnforcedAt]
 * @property {number | string | null} [enforcedTarget]
 * @property {string | number | null} [manualOverrideAccount]
 * @property {boolean} [paused]
 */

export const STORAGE_KEY = "accountSwitcherState";
export const SESSION_TABS_KEY = "accountSwitcherTabs";
export const STATE_VERSION = 1;
export const BOUNCE_COOLDOWN_MS = 8000;
export const POPUP_SYNC_COOLDOWN_MS = 2 * 60 * 1000;

export const DEFAULT_BUILTIN_ORIGIN = "https://*.google.com/*";

/** @type {ReadonlyArray<Omit<ServiceRule, "enabled" | "accountEmail" | "custom">>} */
export const STARTER_SERVICES = [
  { id: "docs.google.com", label: "Google Docs", host: "docs.google.com", pathPrefix: "" },
  { id: "drive.google.com", label: "Google Drive", host: "drive.google.com", pathPrefix: "" },
  { id: "mail.google.com", label: "Gmail", host: "mail.google.com", pathPrefix: "" },
  { id: "calendar.google.com", label: "Google Calendar", host: "calendar.google.com", pathPrefix: "" },
  { id: "meet.google.com", label: "Google Meet", host: "meet.google.com", pathPrefix: "" },
  { id: "classroom.google.com", label: "Google Classroom", host: "classroom.google.com", pathPrefix: "" },
  { id: "gemini.google.com", label: "Google Gemini", host: "gemini.google.com", pathPrefix: "" },
  { id: "aistudio.google.com", label: "Google AI Studio", host: "aistudio.google.com", pathPrefix: "" },
  { id: "notebooklm.google.com", label: "NotebookLM", host: "notebooklm.google.com", pathPrefix: "" },
  { id: "colab.research.google.com", label: "Google Colab", host: "colab.research.google.com", pathPrefix: "" },
  { id: "console.cloud.google.com", label: "Cloud Console", host: "console.cloud.google.com", pathPrefix: "" },
  { id: "photos.google.com", label: "Google Photos", host: "photos.google.com", pathPrefix: "" },
  { id: "keep.google.com", label: "Google Keep", host: "keep.google.com", pathPrefix: "" },
];

/** @type {ReadonlyArray<{ id: string; label: string; host: string; pathPrefix: string }>} */
export const SUB_APP_PRESETS = [
  { id: "docs.google.com/forms", label: "Google Forms", host: "docs.google.com", pathPrefix: "/forms" },
  { id: "docs.google.com/spreadsheets", label: "Google Sheets", host: "docs.google.com", pathPrefix: "/spreadsheets" },
  { id: "docs.google.com/presentation", label: "Google Slides", host: "docs.google.com", pathPrefix: "/presentation" },
  { id: "docs.google.com/document", label: "Google Docs (documents only)", host: "docs.google.com", pathPrefix: "/document" },
];

export const EXCLUDED_HOSTS = new Set([
  "accounts.google.com",
  "accounts.youtube.com",
  "ogs.google.com",
  "apis.google.com",
  "www.googleapis.com",
  "content.googleapis.com",
  "ssl.gstatic.com",
  "www.gstatic.com",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "lh3.googleusercontent.com",
]);

export const EXCLUDED_HOST_SUFFIXES = [
  ".googleusercontent.com",
  ".usercontent.google.com",
  ".gstatic.com",
  ".googleapis.com",
];

export const EXCLUDED_PATH_PREFIXES = [
  "/logout",
  "/servicelogin",
  "/accountchooser",
  "/checkcookie",
  "/rotatecookiespage",
  "/listaccounts",
  "/o/oauth2",
  "/v3/signin",
  "/signin",
  "/signoutoptions",
];

/**
 * Build initial clean extension state (strict allowlist: starter services start disabled).
 * @returns {ExtensionState}
 */
export function createInitialState() {
  return {
    version: STATE_VERSION,
    redirectEnabled: true,
    theme: "system",
    defaultAccountEmail: null,
    accounts: [],
    lastAccountSyncAt: 0,
    services: STARTER_SERVICES.map((svc) => ({
      ...svc,
      enabled: false,
      accountEmail: null,
      custom: false,
    })),
  };
}
