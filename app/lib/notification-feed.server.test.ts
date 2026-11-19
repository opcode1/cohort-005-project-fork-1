import { generateKeyPairSync, verify, type KeyObject } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  mintUserToken,
  notificationFeedFor,
  serviceWorkerScript,
} from "./notification-feed.server";

function decodeSegment(segment: string) {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

function verifiesWith(publicKey: KeyObject, token: string) {
  const [header, payload, signature] = token.split(".");
  return verify(
    "sha256",
    Buffer.from(`${header}.${payload}`),
    { key: publicKey, dsaEncoding: "ieee-p1363" },
    Buffer.from(signature, "base64url")
  );
}

describe("user tokens for the Notification Feed (secure mode)", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const now = new Date("2026-11-19T12:00:00Z");

  it("mints a 1-hour ES256 token for the user that verifies with the public key", () => {
    const token = mintUserToken(7, pem, now);

    expect(verifiesWith(publicKey, token)).toBe(true);
    const [header, payload] = token.split(".");
    expect(decodeSegment(header)).toEqual({ alg: "ES256", typ: "JWT" });
    expect(decodeSegment(payload)).toEqual({
      entity_type: "subscriber",
      entity_id: "7",
      iat: 1795089600,
      exp: 1795093200,
    });
  });

  it("signs with a key written on one line with \\n escapes, as in .env", () => {
    const env = { SUPRSEND_SIGNING_KEY: pem.trim().replaceAll("\n", "\\n") };

    const feed = notificationFeedFor(7, env, now);

    expect(feed.distinctId).toBe("7");
    expect(feed.userToken).not.toBeNull();
    expect(verifiesWith(publicKey, feed.userToken ?? "")).toBe(true);
  });

  it("signs with the one-line Base64 form SuprSend's dashboard offers", () => {
    const env = { SUPRSEND_SIGNING_KEY: Buffer.from(pem).toString("base64") };

    const feed = notificationFeedFor(7, env, now);

    expect(verifiesWith(publicKey, feed.userToken ?? "")).toBe(true);
  });

  it("gives no token without a signing key, so the bell shows an empty feed", () => {
    expect(notificationFeedFor(7, {}, now)).toEqual({
      publicApiKey: null,
      vapidKey: null,
      distinctId: "7",
      userToken: null,
    });
  });

  it("hands the browser the VAPID key it subscribes to web push with", () => {
    const env = {
      SUPRSEND_PUBLIC_API_KEY: "public",
      SUPRSEND_VAPID_KEY: "vapid",
    };

    expect(notificationFeedFor(7, env, now).vapidKey).toBe("vapid");
  });

  it("gives no token, rather than breaking the page, when the signing key is unreadable", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const feed = notificationFeedFor(
      7,
      { SUPRSEND_SIGNING_KEY: "nonsense" },
      now
    );

    expect(feed.userToken).toBeNull();
    expect(error).toHaveBeenCalled();
    expect(JSON.stringify(error.mock.calls)).not.toContain("nonsense");
    error.mockRestore();
  });

  it("gives a signed-out visitor no distinct id and no token", () => {
    const env = {
      SUPRSEND_PUBLIC_API_KEY: "public",
      SUPRSEND_SIGNING_KEY: pem,
    };

    expect(notificationFeedFor(null, env, now)).toEqual({
      publicApiKey: "public",
      vapidKey: null,
      distinctId: null,
      userToken: null,
    });
  });
});

// The browser's push service worker reports each push delivered and clicked
// to SuprSend, which needs this environment's public key to record them.
describe("the push service worker", () => {
  it("starts SuprSend's worker with this environment's public key", () => {
    const script = serviceWorkerScript({ SUPRSEND_PUBLIC_API_KEY: "public" });

    expect(script).toContain("addEventListener('push'");
    expect(script.trimEnd().endsWith('initSuprSend("public");')).toBe(true);
  });

  it("still shows pushes without a public key, but reports nothing", () => {
    const script = serviceWorkerScript({});

    expect(script).toContain("addEventListener('push'");
    expect(script).not.toContain('initSuprSend("');
  });
});
