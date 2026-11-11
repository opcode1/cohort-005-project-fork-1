import { describe, it, expect } from "vitest";
import { decideRefundEligibility, type RefundFacts } from "./refund-eligibility";

// Dates are built in local time because the window is counted in the
// learner's calendar days, not in hours.
const BOUGHT_AT = new Date(2026, 0, 1, 23, 0);
const DAY_AFTER = new Date(2026, 0, 2, 9, 0);

function facts(overrides: Partial<RefundFacts> = {}): RefundFacts {
  return {
    purchasedAt: BOUGHT_AT.toISOString(),
    amountPaid: 4900,
    secondsWatched: 0,
    completedLessons: 0,
    totalLessons: 10,
    isClaimedTeamSeat: false,
    hasPendingRequest: false,
    ...overrides,
  };
}

describe("decideRefundEligibility", () => {
  it("offers the full list price on a fresh purchase", () => {
    expect(decideRefundEligibility(facts(), new Date(2026, 0, 2, 9, 0))).toEqual({
      eligible: true,
      amount: 4900,
      lastDayInWindow: "2026-01-15",
    });
  });

  describe("the 14-day window", () => {
    it("is still open at the very end of the fourteenth day", () => {
      const lastMinute = new Date(2026, 0, 15, 23, 59);
      expect(decideRefundEligibility(facts(), lastMinute).eligible).toBe(true);
    });

    it("is closed from the first minute of the fifteenth day", () => {
      const firstMinute = new Date(2026, 0, 16, 0, 0);
      expect(decideRefundEligibility(facts(), firstMinute)).toEqual({
        eligible: false,
        reason: "window-closed",
      });
    });
  });

  describe("watch time", () => {
    const TWO_HOURS = 2 * 60 * 60;

    it("allows a learner who has watched just under two hours", () => {
      const result = decideRefundEligibility(
        facts({ secondsWatched: TWO_HOURS - 1 }),
        DAY_AFTER
      );
      expect(result.eligible).toBe(true);
    });

    it("refuses a learner who has watched two hours", () => {
      expect(
        decideRefundEligibility(facts({ secondsWatched: TWO_HOURS }), DAY_AFTER)
      ).toEqual({ eligible: false, reason: "watched-too-much" });
    });
  });

  describe("lessons completed", () => {
    it("allows a learner who has completed under half the lessons", () => {
      const result = decideRefundEligibility(
        facts({ completedLessons: 4, totalLessons: 10 }),
        DAY_AFTER
      );
      expect(result.eligible).toBe(true);
    });

    it("refuses a learner who has completed half the lessons", () => {
      expect(
        decideRefundEligibility(
          facts({ completedLessons: 5, totalLessons: 10 }),
          DAY_AFTER
        )
      ).toEqual({ eligible: false, reason: "completed-too-much" });
    });

    it("does not count completion on a course with no lessons", () => {
      const result = decideRefundEligibility(
        facts({ completedLessons: 0, totalLessons: 0 }),
        DAY_AFTER
      );
      expect(result.eligible).toBe(true);
    });
  });

  it("refuses a claimed team seat, which belongs to the team", () => {
    expect(
      decideRefundEligibility(facts({ isClaimedTeamSeat: true }), DAY_AFTER)
    ).toEqual({ eligible: false, reason: "claimed-team-seat" });
  });

  it("refuses a second request while one is still Pending", () => {
    expect(
      decideRefundEligibility(facts({ hasPendingRequest: true }), DAY_AFTER)
    ).toEqual({ eligible: false, reason: "request-pending" });
  });

  describe("the Refund amount", () => {
    it("gives back exactly what was paid", () => {
      const result = decideRefundEligibility(
        facts({ amountPaid: 2450 }),
        DAY_AFTER
      );
      expect(result).toMatchObject({ eligible: true, amount: 2450 });
    });
  });
});
