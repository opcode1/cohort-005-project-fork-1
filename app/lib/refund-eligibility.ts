// ─── Refund Request eligibility ───
// The one place that decides whether a learner may make a Refund Request,
// and what their Refund would be. The course page (to offer the form) and the
// refund action (to accept it) both ask here.

export const REFUND_WINDOW_DAYS = 14;
export const REFUND_WATCH_LIMIT_SECONDS = 2 * 60 * 60;
/** The share of lessons completed at which a refund is no longer offered. */
export const REFUND_COMPLETION_LIMIT = 0.5;

export type RefundFacts = {
  /** When the latest purchase of the course was made, as an ISO string. */
  purchasedAt: string;
  amountPaid: number;
  secondsWatched: number;
  completedLessons: number;
  totalLessons: number;
  isClaimedTeamSeat: boolean;
  hasPendingRequest: boolean;
};

export type RefundRefusal =
  | "request-pending"
  | "claimed-team-seat"
  | "window-closed"
  | "watched-too-much"
  | "completed-too-much";

export type RefundEligibility =
  | { eligible: true; amount: number; lastDayInWindow: string }
  | { eligible: false; reason: RefundRefusal };

// The window is counted in whole calendar days, not hours: someone who buys
// at 23:00 still gets the whole of their fourteenth day.
function calendarDay(when: Date): string {
  const month = String(when.getMonth() + 1).padStart(2, "0");
  const day = String(when.getDate()).padStart(2, "0");
  return `${when.getFullYear()}-${month}-${day}`;
}

export function decideRefundEligibility(
  facts: RefundFacts,
  today: Date
): RefundEligibility {
  const windowEnd = new Date(facts.purchasedAt);
  windowEnd.setDate(windowEnd.getDate() + REFUND_WINDOW_DAYS);
  const lastDayInWindow = calendarDay(windowEnd);

  if (facts.hasPendingRequest) {
    return { eligible: false, reason: "request-pending" };
  }

  // A seat that came out of a team licence, and has been claimed, belongs to
  // the team: the learner cannot hand it back on their own.
  if (facts.isClaimedTeamSeat) {
    return { eligible: false, reason: "claimed-team-seat" };
  }

  if (calendarDay(today) > lastDayInWindow) {
    return { eligible: false, reason: "window-closed" };
  }

  if (facts.secondsWatched >= REFUND_WATCH_LIMIT_SECONDS) {
    return { eligible: false, reason: "watched-too-much" };
  }

  if (
    facts.totalLessons > 0 &&
    facts.completedLessons / facts.totalLessons >= REFUND_COMPLETION_LIMIT
  ) {
    return { eligible: false, reason: "completed-too-much" };
  }

  // A Refund is exactly what the learner paid, whatever the course costs now:
  // prices change, and a Refund must never be more or less than the payment.
  return { eligible: true, amount: facts.amountPaid, lastDayInWindow };
}
