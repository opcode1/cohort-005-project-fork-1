// ─── Server configuration ───
// Settings that differ per environment. Functions take the environment as a
// parameter, so tests hand one in and never read the real SUPRSEND_* values.

type Env = Record<string, string | undefined>;

// Production must never fall back to writing messages to disk.
const REQUIRED_IN_PRODUCTION = [
  "SUPRSEND_WORKSPACE_KEY",
  "SUPRSEND_WORKSPACE_SECRET",
  "SUPRSEND_PUBLIC_API_KEY",
  "SUPRSEND_SIGNING_KEY",
  // The browser subscribes to web push with it (public, not a secret).
  "SUPRSEND_VAPID_KEY",
  "POSTMARK_SERVER_TOKEN",
  // Push needs absolute links, and they must not come from the request.
  "APP_BASE_URL",
  // Signs the session cookie. Without it the secret is the one in the code.
  "SESSION_SECRET",
] as const;

/** Throws, naming what is missing, when production lacks a required key. */
export function assertProductionConfig(env: Env) {
  if (env.NODE_ENV !== "production") return;

  const missing = REQUIRED_IN_PRODUCTION.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(
      `Cadence will not start in production without: ${missing.join(", ")}`
    );
  }
}

const DEV_BASE_URL = "http://localhost:5173";

/** Where this environment's app is served, for absolute links. */
export function appBaseUrl(env: Env) {
  return env.APP_BASE_URL || DEV_BASE_URL;
}
