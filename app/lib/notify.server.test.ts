import { generateKeyPairSync, verify, type KeyObject } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  mintUserToken,
  notificationFeedFor,
  notificationFileTransport,
} from "./notify.server";

function readOnlyFile(directory: string) {
  const files = readdirSync(directory);
  expect(files).toHaveLength(1);
  return JSON.parse(readFileSync(join(directory, files[0]), "utf8"));
}

describe("the .outbox/notifications/ transport, used without SuprSend keys", () => {
  it("writes the workflow trigger it would have sent, with an absolute link", async () => {
    const directory = mkdtempSync(join(tmpdir(), "notifications-"));

    const result = await notificationFileTransport(
      directory,
      "https://cadence.example"
    ).trigger(
      {
        workflow: "question-asked",
        recipient: { distinct_id: "2", $email: "ina@example.com", name: "Ina" },
        data: { course_title: "Test Course", asker_name: "Sam" },
        link: "/courses/test-course/lessons/3#comment-4",
      },
      "question-asked:comment:4:user:2"
    );

    expect(result).toEqual({ ok: true });
    expect(readOnlyFile(directory)).toEqual({
      workflow: "question-asked",
      recipients: [
        { distinct_id: "2", $email: "ina@example.com", name: "Ina" },
      ],
      data: {
        course_title: "Test Course",
        asker_name: "Sam",
        url: "https://cadence.example/courses/test-course/lessons/3#comment-4",
      },
      idempotency_key: "question-asked:comment:4:user:2",
    });
  });

  it("writes the email swap it would have made", async () => {
    const directory = mkdtempSync(join(tmpdir(), "notifications-"));

    const result = await notificationFileTransport(
      directory,
      "https://cadence.example"
    ).updateUser({
      distinct_id: "7",
      removeEmail: "old@example.com",
      addEmail: "new@example.com",
    });

    expect(result).toEqual({ ok: true });
    expect(readOnlyFile(directory)).toEqual({
      distinct_id: "7",
      remove_email: "old@example.com",
      add_email: "new@example.com",
    });
  });
});

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
