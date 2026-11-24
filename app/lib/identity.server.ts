import { createCookieSessionStorage, data } from "react-router";

// ─── Identity ───
// Who is making this request, and the dev-only shortcuts around that. The
// environment is a parameter, so tests hand one in.

type Env = Record<string, string | undefined>;

const DEV_SECRET = "cadence-dev-secret";

export function createIdentity(env: Env) {
  // The DevUI panel's shortcuts: switching user and choosing a country.
  const devTools = env.NODE_ENV !== "production";

  const storage = createCookieSessionStorage({
    cookie: {
      name: "cadence_session",
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: !devTools,
      secrets: [env.SESSION_SECRET || DEV_SECRET],
    },
  });

  function sessionOf(request: Request) {
    return storage.getSession(request.headers.get("Cookie"));
  }

  // Production answers the DevUI's routes as if they were not there.
  function requireDevTools() {
    if (!devTools) throw data("Not found", { status: 404 });
  }

  async function devCountry(request: Request): Promise<string | null> {
    if (!devTools) return null;
    const country = (await sessionOf(request)).get("devCountry");
    return typeof country === "string" && country.length === 2
      ? country.toUpperCase()
      : null;
  }

  async function signIn(request: Request, userId: number) {
    const session = await sessionOf(request);
    session.set("userId", userId);
    return storage.commitSession(session);
  }

  return {
    /** Whether the DevUI panel and its shortcuts are available. */
    devTools,

    async currentUserId(request: Request): Promise<number | null> {
      const userId = (await sessionOf(request)).get("userId");
      return typeof userId === "number" ? userId : null;
    },

    /** Returns the Set-Cookie header that signs this browser in. */
    signIn,

    /**
     * The country to price for, as a 2-letter ISO code, or null for full
     * price. The DevUI override first, then Cloudflare's CF-IPCountry header.
     * Never a network call.
     */
    async country(request: Request): Promise<string | null> {
      const override = await devCountry(request);
      if (override) return override;

      const cfCountry = request.headers.get("CF-IPCountry");
      if (cfCountry && cfCountry.length === 2 && cfCountry !== "XX") {
        return cfCountry.toUpperCase();
      }

      return null;
    },

    /** The country chosen in the DevUI panel; null in production. */
    devCountry,

    /** Returns the Set-Cookie header that prices this browser as `country`. */
    async setDevCountry(request: Request, country: string | null) {
      requireDevTools();
      const session = await sessionOf(request);
      if (country) {
        session.set("devCountry", country);
      } else {
        session.unset("devCountry");
      }
      return storage.commitSession(session);
    },

    /** The DevUI's user switch: signs in as `userId` with no checks. */
    async switchUser(request: Request, userId: number) {
      requireDevTools();
      return signIn(request, userId);
    },

    /** Returns the Set-Cookie header that signs this browser out. */
    async signOut(request: Request) {
      return storage.destroySession(await sessionOf(request));
    },
  };
}

/**
 * `target` when it is a path on this site, else `fallback`. For redirectTo
 * values, which arrive in the URL and so can point anywhere.
 */
export function safeRedirect(target: string | null, fallback: string) {
  if (!target || !target.startsWith("/")) return fallback;

  // Parse it as a browser would: "//host", "/\\host" and "/<tab>/host" all
  // leave this site.
  const base = "http://cadence.invalid";
  const url = new URL(target, base);
  return url.origin === base ? target : fallback;
}

/** This server's identity, configured from its environment. */
export const identity = createIdentity(process.env);
