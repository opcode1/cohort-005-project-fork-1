import { createPrivateKey, sign } from "node:crypto";
import { errorMessage } from "~/lib/utils";

// ─── Notification Feed sessions ───
// What the browser needs to open the signed-in person's Notification Feed:
// SuprSend's public keys and a token signed for that person. Secure mode is
// on for the public key in every workspace (docs/adr/0015), so the feed
// can't be read without the token. The app layout's loader and the token
// refresh route read it from here; neither imports the notify module
// (docs/adr/0016).

const USER_TOKEN_LIFETIME_SECONDS = 60 * 60;

function base64url(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
}

function signingKeyPem(signingKey: string) {
  const pem = signingKey.includes("BEGIN")
    ? signingKey
    : Buffer.from(signingKey, "base64").toString("utf8");
  return pem.replaceAll("\\n", "\n");
}

/**
 * A 1-hour ES256 token that lets the browser read `userId`'s feed.
 * `signingKey` is the per-environment key: a PEM, multi-line or on one line
 * with `\n` escapes, or the one-line Base64 of that PEM that SuprSend's
 * dashboard offers.
 */
export function mintUserToken(userId: number, signingKey: string, now: Date) {
  const key = createPrivateKey(signingKeyPem(signingKey));
  const iat = Math.floor(now.getTime() / 1000);
  const header = base64url(JSON.stringify({ alg: "ES256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      entity_type: "subscriber",
      entity_id: String(userId),
      iat,
      exp: iat + USER_TOKEN_LIFETIME_SECONDS,
    })
  );
  // JWS wants the raw r||s signature, not Node's default DER encoding.
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), {
    key,
    dsaEncoding: "ieee-p1363",
  });
  return `${header}.${payload}.${base64url(signature)}`;
}

/** What the browser needs to open the signed-in person's feed. */
export type NotificationFeedSession = {
  publicApiKey: string | null;
  // Public: the browser subscribes to web push with it.
  vapidKey: string | null;
  // Both null when nobody is signed in.
  distinctId: string | null;
  userToken: string | null;
};

export function notificationFeedFor(
  userId: number | null,
  env: Record<string, string | undefined> = process.env,
  now = new Date()
): NotificationFeedSession {
  const publicApiKey = env.SUPRSEND_PUBLIC_API_KEY || null;
  const vapidKey = env.SUPRSEND_VAPID_KEY || null;
  if (userId === null) {
    return { publicApiKey, vapidKey, distinctId: null, userToken: null };
  }

  return {
    publicApiKey,
    vapidKey,
    distinctId: String(userId),
    userToken: userTokenFor(userId, env.SUPRSEND_SIGNING_KEY, now),
  };
}

// Without a usable key the bell shows an empty feed; it never breaks a page.
function userTokenFor(
  userId: number,
  signingKey: string | undefined,
  now: Date
) {
  if (!signingKey) return null;
  try {
    return mintUserToken(userId, signingKey, now);
  } catch (error) {
    // Name the setting, never its value.
    console.error(
      `SUPRSEND_SIGNING_KEY could not be read as a private key (PEM, or its Base64): ${errorMessage(error)}`
    );
    return null;
  }
}
