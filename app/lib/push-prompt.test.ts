import { describe, expect, it } from "vitest";
import {
  shouldAskForPush,
  snoozeUntil,
  type PushAskState,
} from "./push-prompt";

const NOW = new Date("2026-11-19T12:00:00Z").getTime();
const DAY = 24 * 60 * 60 * 1000;

// A browser that has never been asked, with a push-eligible Notification
// just arrived: the one situation where Cadence asks.
const ASKABLE: PushAskState = {
  permission: "default",
  supported: true,
  turnedOffInCadence: false,
  snoozedUntil: null,
  askedThisPageLoad: false,
  pushEligible: true,
  now: NOW,
};

describe("shouldAskForPush", () => {
  it("asks when a push-eligible Notification arrives in a browser never asked", () => {
    expect(shouldAskForPush(ASKABLE)).toBe(true);
  });

  it("never asks about a feed-only Notification", () => {
    expect(shouldAskForPush({ ...ASKABLE, pushEligible: false })).toBe(false);
  });

  it("never asks once the browser has blocked push", () => {
    expect(shouldAskForPush({ ...ASKABLE, permission: "denied" })).toBe(false);
  });

  it("never asks once the browser has granted permission", () => {
    expect(shouldAskForPush({ ...ASKABLE, permission: "granted" })).toBe(false);
  });

  it("never asks on a browser that can't receive push", () => {
    expect(shouldAskForPush({ ...ASKABLE, supported: false })).toBe(false);
  });

  it("never asks after push was turned off in Cadence", () => {
    expect(shouldAskForPush({ ...ASKABLE, turnedOffInCadence: true })).toBe(
      false
    );
  });

  it("asks at most once per page load", () => {
    expect(shouldAskForPush({ ...ASKABLE, askedThisPageLoad: true })).toBe(
      false
    );
  });

  describe("after Not now", () => {
    it("snoozes the ask for 30 days", () => {
      expect(snoozeUntil(NOW)).toBe(new Date("2026-12-19T12:00:00Z").getTime());
    });

    it("doesn't ask while the snooze is active", () => {
      const snoozed = { ...ASKABLE, snoozedUntil: snoozeUntil(NOW) };

      expect(shouldAskForPush({ ...snoozed, now: NOW + DAY })).toBe(false);
      expect(shouldAskForPush({ ...snoozed, now: NOW + 30 * DAY - 1 })).toBe(
        false
      );
    });

    it("asks again once the snooze has expired", () => {
      const snoozed = { ...ASKABLE, snoozedUntil: snoozeUntil(NOW) };

      expect(shouldAskForPush({ ...snoozed, now: NOW + 30 * DAY })).toBe(true);
      expect(shouldAskForPush({ ...snoozed, now: NOW + 45 * DAY })).toBe(true);
    });
  });
});
