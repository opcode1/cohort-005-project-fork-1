import { describe, expect, it } from "vitest";
import { assertProductionConfig } from "./config.server";

const COMPLETE = {
  NODE_ENV: "production",
  SUPRSEND_WORKSPACE_KEY: "key",
  SUPRSEND_WORKSPACE_SECRET: "secret",
  SUPRSEND_PUBLIC_API_KEY: "public",
  SUPRSEND_SIGNING_KEY: "pem",
  SUPRSEND_VAPID_KEY: "vapid",
  POSTMARK_SERVER_TOKEN: "token",
  APP_BASE_URL: "https://cadence.example",
  SESSION_SECRET: "a-long-random-string",
};

describe("assertProductionConfig", () => {
  it("lets production boot with every key set", () => {
    expect(() => assertProductionConfig(COMPLETE)).not.toThrow();
  });

  it("refuses to boot production, naming each missing key", () => {
    const env = {
      ...COMPLETE,
      SUPRSEND_SIGNING_KEY: "",
      POSTMARK_SERVER_TOKEN: undefined,
    };

    expect(() => assertProductionConfig(env)).toThrow(
      "Cadence will not start in production without: SUPRSEND_SIGNING_KEY, POSTMARK_SERVER_TOKEN"
    );
  });

  it("refuses to boot production without the web push VAPID key", () => {
    expect(() =>
      assertProductionConfig({ ...COMPLETE, SUPRSEND_VAPID_KEY: undefined })
    ).toThrow(
      "Cadence will not start in production without: SUPRSEND_VAPID_KEY"
    );
  });

  it("refuses to boot production without a session cookie secret", () => {
    expect(() =>
      assertProductionConfig({ ...COMPLETE, SESSION_SECRET: undefined })
    ).toThrow("Cadence will not start in production without: SESSION_SECRET");
  });

  it("lets development boot with no keys at all", () => {
    expect(() =>
      assertProductionConfig({ NODE_ENV: "development" })
    ).not.toThrow();
  });
});
