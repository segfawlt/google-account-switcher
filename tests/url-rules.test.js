import { describe, expect, it } from "vitest";
import { createInitialState } from "../src/core/constants.js";
import {
  buildRedirectUrl,
  evaluateNavigationRequest,
  extractUrlAccount,
  isExcludedUrl,
  matchServiceRule,
  normalizeServiceInput,
} from "../src/core/url-rules.js";

function makePopulatedState() {
  const base = createInitialState();
  base.defaultAccountEmail = "work@rivera.dev";
  base.accounts = [
    { email: "alex.rivera@gmail.com", index: 0, hidden: false },
    { email: "sam.chen@gmail.com", index: 1, hidden: false },
    { email: "alex@northstar.studio", index: 2, hidden: false },
    { email: "archive.box@gmail.com", index: 3, hidden: false },
    { email: "work@rivera.dev", index: 4, hidden: false },
  ];
  // Enable ONLY docs.google.com and custom antigravity.google.com
  const docs = base.services.find((s) => s.id === "docs.google.com");
  docs.enabled = true;

  base.services.unshift({
    id: "antigravity.google.com",
    label: "antigravity.google.com",
    host: "antigravity.google.com",
    pathPrefix: "",
    enabled: true,
    accountEmail: "alex@northstar.studio", // index 2 override
    custom: true,
  });

  return base;
}

describe("normalizeServiceInput", () => {
  it("normalizes bare domains, full URLs, and sub-app paths", () => {
    const bare = normalizeServiceInput("antigravity.google.com");
    expect(bare).toEqual({
      ok: true,
      id: "antigravity.google.com",
      host: "antigravity.google.com",
      pathPrefix: "",
      label: "antigravity.google.com",
      originPattern: "https://antigravity.google.com/*",
    });

    const fullTabCapture = normalizeServiceInput(
      "https://antigravity.google.com/workspace/chat?foo=bar",
      { keepPath: false }
    );
    expect(fullTabCapture).toMatchObject({
      ok: true,
      id: "antigravity.google.com",
      host: "antigravity.google.com",
      pathPrefix: "",
    });

    const subPath = normalizeServiceInput("https://docs.google.com/forms/u/0/");
    expect(subPath).toMatchObject({
      ok: true,
      id: "docs.google.com/forms",
      host: "docs.google.com",
      pathPrefix: "/forms",
      label: "Google Forms",
    });
  });

  it("rejects auth endpoints like accounts.google.com", () => {
    const res = normalizeServiceInput("accounts.google.com");
    expect(res.ok).toBe(false);
  });
});

describe("URL rewriting & exclusion rules", () => {
  it("rewrites /u/0/ paths to /u/4/ and strips conflicting authuser query params", () => {
    const url = new URL("https://mail.google.com/mail/u/0/?authuser=0#inbox");
    expect(buildRedirectUrl(url, { email: "work@rivera.dev", index: 4 })).toBe(
      "https://mail.google.com/mail/u/4/#inbox"
    );
  });

  it("appends ?authuser=4 on shared doc links and custom apps without /u/ segments", () => {
    const docUrl = new URL("https://docs.google.com/document/d/1AbCdEfG/edit?usp=sharing");
    expect(buildRedirectUrl(docUrl, { email: "work@rivera.dev", index: 4 })).toBe(
      "https://docs.google.com/document/d/1AbCdEfG/edit?usp=sharing&authuser=4"
    );

    const agyUrl = new URL("https://antigravity.google.com/");
    expect(buildRedirectUrl(agyUrl, { email: "alex@northstar.studio", index: 2 })).toBe(
      "https://antigravity.google.com/?authuser=2"
    );
  });

  it("never redirects OAuth, logout, AccountChooser, or Drive direct downloads", () => {
    expect(isExcludedUrl(new URL("https://accounts.google.com/o/oauth2/v2/auth"))).toBe(true);
    expect(isExcludedUrl(new URL("https://mail.google.com/Logout"))).toBe(true);
    expect(isExcludedUrl(new URL("https://drive.google.com/uc?id=123&export=download"))).toBe(true);
    expect(isExcludedUrl(new URL("https://docs.google.com/document/u/0/"))).toBe(false);
  });

  it("matches longest pathPrefix when sub-apps override a host rule", () => {
    const state = makePopulatedState();
    state.services.unshift({
      id: "docs.google.com/forms",
      label: "Google Forms",
      host: "docs.google.com",
      pathPrefix: "/forms",
      enabled: true,
      accountEmail: "alex@northstar.studio",
      custom: true,
    });

    const formsMatch = matchServiceRule(
      new URL("https://docs.google.com/forms/d/e/123/viewform"),
      state.services
    );
    expect(formsMatch?.id).toBe("docs.google.com/forms");

    const docsMatch = matchServiceRule(
      new URL("https://docs.google.com/document/d/123/edit"),
      state.services
    );
    expect(docsMatch?.id).toBe("docs.google.com");
  });

  it("extracts path and query account indicators accurately", () => {
    expect(extractUrlAccount(new URL("https://docs.google.com/document/u/3/"))).toEqual({
      kind: "path",
      value: 3,
      raw: "3",
    });
    expect(extractUrlAccount(new URL("https://antigravity.google.com/?authuser=2"))).toEqual({
      kind: "query-index",
      value: 2,
      raw: "2",
    });
  });
});

describe("evaluateNavigationRequest (strict allowlist + smart switch + loop guard)", () => {
  it("enforces Default Account on enabled allowlist app and leaves disabled apps untouched", () => {
    const state = makePopulatedState();

    // docs.google.com is enabled -> redirects to Default Account (index 4)
    const docsRes = evaluateNavigationRequest({
      urlString: "https://docs.google.com/document/u/0/",
      method: "GET",
      resourceType: "main_frame",
      tabId: 10,
      state,
      now: 1000,
    });
    expect(docsRes.action).toBe("redirect");
    expect(docsRes.redirectUrl).toBe("https://docs.google.com/document/u/4/");

    // mail.google.com is in starter list but toggled OFF -> strictly untouched!
    const gmailRes = evaluateNavigationRequest({
      urlString: "https://mail.google.com/mail/u/0/#inbox",
      method: "GET",
      resourceType: "main_frame",
      tabId: 11,
      state,
      now: 1000,
    });
    expect(gmailRes.action).toBe("allow");

    // Unlisted subdomain (maps.google.com) -> strictly untouched!
    const mapsRes = evaluateNavigationRequest({
      urlString: "https://maps.google.com/",
      method: "GET",
      resourceType: "main_frame",
      tabId: 12,
      state,
      now: 1000,
    });
    expect(mapsRes.action).toBe("allow");
  });

  it("prevents infinite redirect loops when an SPA like antigravity.google.com strips ?authuser=2", () => {
    const state = makePopulatedState();

    // 1. Initial visit to https://antigravity.google.com/
    const step1 = evaluateNavigationRequest({
      urlString: "https://antigravity.google.com/",
      method: "GET",
      resourceType: "main_frame",
      tabId: 25,
      state,
      now: 10_000,
    });
    expect(step1.action).toBe("redirect");
    expect(step1.redirectUrl).toBe("https://antigravity.google.com/?authuser=2");

    // 2. 200ms later, antigravity.google.com sets session cookie and 302-redirects back to clean "/"
    const step2 = evaluateNavigationRequest({
      urlString: "https://antigravity.google.com/",
      method: "GET",
      resourceType: "main_frame",
      tabId: 25,
      state,
      tabRecord: step1.nextTabRecord,
      now: 10_200,
    });
    expect(step2.action).toBe("allow");
  });

  it("respects manual account switches initiated from Google's avatar menu (ogs.google.com)", () => {
    const state = makePopulatedState();

    // Tab initially routed to u/4
    const initial = evaluateNavigationRequest({
      urlString: "https://docs.google.com/document/u/4/",
      method: "GET",
      resourceType: "main_frame",
      tabId: 42,
      state,
      now: 5000,
    });
    expect(initial.action).toBe("allow");

    // User clicks account u/1 inside Google's One Google Bar avatar widget (`ogs.google.com`)
    const manualSwitch = evaluateNavigationRequest({
      urlString: "https://docs.google.com/document/u/1/",
      method: "GET",
      resourceType: "main_frame",
      tabId: 42,
      originUrlString: "https://ogs.google.com/u/4/widget/account",
      state,
      tabRecord: initial.nextTabRecord,
      now: 9000,
    });
    expect(manualSwitch.action).toBe("allow");
    expect(manualSwitch.nextTabRecord?.manualOverrideAccount).toBe(1);

    // Subsequent doc navigation inside that same tab stays un-hijacked
    const followUp = evaluateNavigationRequest({
      urlString: "https://docs.google.com/document/d/xyz/edit",
      method: "GET",
      resourceType: "main_frame",
      tabId: 42,
      originUrlString: "https://docs.google.com/document/u/1/",
      state,
      tabRecord: manualSwitch.nextTabRecord,
      now: 15_000,
    });
    expect(followUp.action).toBe("allow");
  });
});
