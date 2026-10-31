import { describe, expect, it } from "vitest";
import { createInitialState } from "../src/core/constants.js";
import { parseListAccountsResponse } from "../src/core/google-accounts.js";
import {
  applyImportedAccounts,
  removeAccountFromState,
  upsertManualAccount,
  upsertServiceRule,
} from "../src/core/storage.js";

describe("Google ListAccounts parser & stable account index management", () => {
  it("parses Chromium gaia.l.a ListAccounts XSSI payload and skips signed-out entries", () => {
    const raw = `)]}'
["gaia.l.a.r", [
  ["gaia.l.a", 1, "Alex", "alex.rivera@gmail.com", "https://lh3.googleusercontent.com/a/1", 1, 1, 0, null, 1, "1001", null, null, null, 0],
  ["gaia.l.a", 1, "Sam", "sam.chen@gmail.com", "https://lh3.googleusercontent.com/a/2", 1, 1, 0, null, 1, "1002", null, null, null, 0],
  ["gaia.l.a", 0, "Signed Out", "old@gmail.com", "https://lh3.googleusercontent.com/a/old", 0, 0, 0, null, 1, "1003", null, null, null, 1],
  ["gaia.l.a", 1, "Work", "work@rivera.dev", "https://lh3.googleusercontent.com/a/3", 1, 1, 0, null, 1, "1004", null, null, null, 0]
]]`;

    const accounts = parseListAccountsResponse(raw);
    expect(accounts).toEqual([
      {
        email: "alex.rivera@gmail.com",
        index: 0,
        name: "Alex",
        avatar: "https://lh3.googleusercontent.com/a/1",
        hidden: false,
      },
      {
        email: "sam.chen@gmail.com",
        index: 1,
        name: "Sam",
        avatar: "https://lh3.googleusercontent.com/a/2",
        hidden: false,
      },
      {
        email: "work@rivera.dev",
        index: 2,
        name: "Work",
        avatar: "https://lh3.googleusercontent.com/a/3",
        hidden: false,
      },
    ]);
  });

  it("preserves sibling u/<index> numbers when removing an account (fixing original extension bug)", () => {
    let state = createInitialState();
    state = applyImportedAccounts(state, [
      { email: "alex.rivera@gmail.com", index: 0 },
      { email: "sam.chen@gmail.com", index: 1 },
      { email: "work@rivera.dev", index: 2 },
    ]);

    // Remove slot 1 (`sam.chen@gmail.com`)
    state = removeAccountFromState(state, "sam.chen@gmail.com");

    const visible = state.accounts.filter((a) => !a.hidden);
    expect(visible.map((a) => ({ email: a.email, index: a.index }))).toEqual([
      { email: "alex.rivera@gmail.com", index: 0 },
      // Must STILL be index 2 in Google's session cookie jar, NOT shifted to 1!
      { email: "work@rivera.dev", index: 2 },
    ]);
  });

  it("supports manual account insertion and adding custom services", () => {
    let state = createInitialState();
    const accRes = upsertManualAccount(state, "work@rivera.dev", 4);
    expect(accRes.ok).toBe(true);
    state = accRes.state;
    expect(state.defaultAccountEmail).toBe("work@rivera.dev");

    const svcRes = upsertServiceRule(state, "antigravity.google.com", {
      enabled: true,
    });
    expect(svcRes.ok).toBe(true);
    expect(svcRes.rule).toMatchObject({
      id: "antigravity.google.com",
      host: "antigravity.google.com",
      enabled: true,
      custom: true,
    });
  });

  it("background auto-sync adds newly signed-in accounts and updates shifted slots while keeping removed accounts hidden", () => {
    let state = createInitialState();
    state = applyImportedAccounts(
      state,
      [
        { email: "alex.rivera@gmail.com", index: 0 },
        { email: "sam.chen@gmail.com", index: 1 },
        { email: "work@rivera.dev", index: 2 },
      ],
      { revealHidden: true, syncedAt: 1000 }
    );

    // User hides slot 1
    state = removeAccountFromState(state, "sam.chen@gmail.com");

    // Later, user logs into a brand-new 4th account (`alex@northstar.studio`), and background sync runs (`revealHidden: false`)
    state = applyImportedAccounts(
      state,
      [
        { email: "alex.rivera@gmail.com", index: 0 },
        { email: "sam.chen@gmail.com", index: 1 },
        { email: "work@rivera.dev", index: 2 },
        { email: "alex@northstar.studio", index: 3 },
      ],
      { revealHidden: false, syncedAt: 5000 }
    );

    expect(state.lastAccountSyncAt).toBe(5000);
    const visible = state.accounts.filter((a) => !a.hidden);
    expect(visible.map((a) => ({ email: a.email, index: a.index }))).toEqual([
      { email: "alex.rivera@gmail.com", index: 0 },
      { email: "work@rivera.dev", index: 2 },
      { email: "alex@northstar.studio", index: 3 },
    ]);
  });
});
