import { describe, expect, it, vi } from "vitest";
import { createIdentity, safeRedirect } from "./identity.server";

const DEV = { NODE_ENV: "development" };
const PRODUCTION = { NODE_ENV: "production", SESSION_SECRET: "the-real-secret" };

/** A request that carries the cookie a Set-Cookie header gave the browser. */
function requestWith(setCookie: string, headers: Record<string, string> = {}) {
  const cookie = setCookie.split(";")[0];
  return new Request("http://localhost:5173/", {
    headers: { Cookie: cookie, ...headers },
  });
}

const anonymous = () => new Request("http://localhost:5173/");

describe("signing in and out", () => {
  it("knows who signed in", async () => {
    const identity = createIdentity(DEV);
    const cookie = await identity.signIn(anonymous(), 7);

    expect(await identity.currentUserId(requestWith(cookie))).toBe(7);
  });

  it("treats a cookie signed with another secret as signed out", async () => {
    const forger = createIdentity({ ...DEV, SESSION_SECRET: "cadence-dev-secret" });
    const forged = await forger.signIn(anonymous(), 1);

    const identity = createIdentity({ ...DEV, SESSION_SECRET: "the-real-secret" });

    expect(await identity.currentUserId(requestWith(forged))).toBeNull();
  });

  it("sends the session cookie over HTTPS only in production", async () => {
    const production = await createIdentity(PRODUCTION).signIn(anonymous(), 7);
    const development = await createIdentity(DEV).signIn(anonymous(), 7);

    expect(production).toMatch(/; Secure/);
    expect(development).not.toMatch(/; Secure/);
  });

  it("forgets who signed in once they sign out", async () => {
    const identity = createIdentity(DEV);
    const signedIn = requestWith(await identity.signIn(anonymous(), 7));
    const cookie = await identity.signOut(signedIn);

    expect(await identity.currentUserId(requestWith(cookie))).toBeNull();
  });
});

describe("country", () => {
  const withHeaders = (headers: Record<string, string>) =>
    new Request("http://localhost:5173/", { headers });

  it("uses Cloudflare's country, upper-cased, when there is no DevUI country", async () => {
    const identity = createIdentity(PRODUCTION);

    expect(await identity.country(withHeaders({ "CF-IPCountry": "de" }))).toBe("DE");
  });

  it("prices at full price for Cloudflare's unknown country XX", async () => {
    const identity = createIdentity(PRODUCTION);

    expect(await identity.country(withHeaders({ "CF-IPCountry": "XX" }))).toBeNull();
  });

  it("prices at full price with no country, never asking the network", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const identity = createIdentity(DEV);

    expect(
      await identity.country(withHeaders({ "X-Forwarded-For": "1.2.3.4" }))
    ).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("ignores a DevUI country that is not two letters", async () => {
    const identity = createIdentity(DEV);
    const cookie = await identity.setDevCountry(anonymous(), "USA");

    expect(await identity.country(requestWith(cookie))).toBeNull();
  });

  it("prefers the DevUI country over Cloudflare's in development", async () => {
    const identity = createIdentity(DEV);
    const cookie = await identity.setDevCountry(anonymous(), "in");

    expect(
      await identity.country(requestWith(cookie, { "CF-IPCountry": "US" }))
    ).toBe("IN");
  });

  it("ignores a DevUI country in production and prices by Cloudflare's", async () => {
    // A devCountry cookie signed with the production secret: one set before
    // production turned dev tools off.
    const planted = await createIdentity({
      ...PRODUCTION,
      NODE_ENV: "development",
    }).setDevCountry(anonymous(), "IN");

    const identity = createIdentity(PRODUCTION);

    expect(
      await identity.country(requestWith(planted, { "CF-IPCountry": "US" }))
    ).toBe("US");
  });
});

describe("DevUI shortcuts", () => {
  it("are on in development and off in production", () => {
    expect(createIdentity(DEV).devTools).toBe(true);
    expect(createIdentity(PRODUCTION).devTools).toBe(false);
  });

  it("switches to any user in development", async () => {
    const identity = createIdentity(DEV);
    const cookie = await identity.switchUser(anonymous(), 3);

    expect(await identity.currentUserId(requestWith(cookie))).toBe(3);
  });

  it("shows the chosen DevUI country in development, and none in production", async () => {
    const planted = await createIdentity({
      ...PRODUCTION,
      NODE_ENV: "development",
    }).setDevCountry(anonymous(), "IN");

    expect(await createIdentity({ ...PRODUCTION, NODE_ENV: "development" }).devCountry(requestWith(planted))).toBe("IN");
    expect(await createIdentity(PRODUCTION).devCountry(requestWith(planted))).toBeNull();
  });

  it("refuses to switch user in production", async () => {
    const identity = createIdentity(PRODUCTION);

    await expect(identity.switchUser(anonymous(), 1)).rejects.toMatchObject({
      init: { status: 404 },
    });
  });

  it("refuses to set a DevUI country in production", async () => {
    const identity = createIdentity(PRODUCTION);

    await expect(identity.setDevCountry(anonymous(), "IN")).rejects.toMatchObject({
      init: { status: 404 },
    });
  });
});

describe("safeRedirect", () => {
  it("goes to a path on this site", () => {
    expect(safeRedirect("/courses/react?tab=notes#top", "/")).toBe(
      "/courses/react?tab=notes#top"
    );
  });

  it.each([
    ["another site", "https://evil.example/"],
    ["a protocol-relative URL", "//evil.example/"],
    ["a backslash the browser reads as a slash", "/\\evil.example/"],
    ["a tab the browser strips", "/\t/evil.example/"],
    ["a script URL", "javascript:alert(1)"],
    ["a relative path", "courses"],
    ["nothing", null],
  ])("falls back for %s", (_, target) => {
    expect(safeRedirect(target, "/courses")).toBe("/courses");
  });
});
