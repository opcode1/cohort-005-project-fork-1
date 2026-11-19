import { and, eq } from "drizzle-orm";
import { coupons, courses, enrollments, purchases } from "~/db/schema";
import type { Db, Tx } from "~/db/types";
import { enrollmentWelcome } from "~/lib/confirmations.server";
import { seatClaimed } from "~/lib/notify.server";
import { enqueue, type OutboxMessage } from "~/lib/outbox.server";
import { getSeatAvailability } from "~/lib/refunds.server";
import { getUser, type User } from "~/lib/users.server";

// ─── Seats ───
// A Student claiming a Seat on a Team Licence. See GLOSSARY.md for Seat,
// Unclaimed Seat and Claimed Seat.
//
// Database first, positional parameters (project convention).

type Purchase = typeof purchases.$inferSelect;

/**
 * The Team Admin who bought the Team Licence hears about each Seat claimed
 * on it, unless they claimed it themselves.
 */
function tellTeamAdmin(
  tx: Tx,
  teamLicence: Purchase | undefined,
  seatId: number,
  courseTitle: string,
  claimant: User
): OutboxMessage[] {
  if (!teamLicence || teamLicence.userId === claimant.id) return [];
  const teamAdmin = getUser(tx, teamLicence.userId);
  return teamAdmin
    ? [seatClaimed(seatId, courseTitle, claimant, teamAdmin)]
    : [];
}

export const SEAT_ON_HOLD =
  "This seat can't be claimed right now. Ask the person who shared it with you.";
export const SEAT_REFUNDED =
  "This seat is no longer available. Ask the person who shared it with you.";

export type ClaimSeatResult =
  | { ok: true; enrollmentId: number; courseId: number }
  | { ok: false; error: string };

/**
 * Claims the Seat with this code for the claimant and enrolls them. Refused
 * when the Seat is claimed, on hold or refunded, when the claimant is already
 * enrolled, or when they are not in the buyer's country.
 */
export function claimSeat(
  db: Db,
  code: string,
  claimantId: number,
  claimantCountry: string | null,
  now: Date
): ClaimSeatResult {
  return db.transaction((tx): ClaimSeatResult => {
    const seat = tx.select().from(coupons).where(eq(coupons.code, code)).get();
    if (!seat) {
      return { ok: false, error: "Coupon not found" };
    }

    if (seat.redeemedByUserId !== null) {
      return { ok: false, error: "Coupon has already been redeemed" };
    }

    const availability = getSeatAvailability(tx, seat);
    if (availability === "on_hold") {
      return { ok: false, error: SEAT_ON_HOLD };
    }
    if (availability === "refunded") {
      return { ok: false, error: SEAT_REFUNDED };
    }

    const existingEnrollment = tx
      .select({ id: enrollments.id })
      .from(enrollments)
      .where(
        and(
          eq(enrollments.userId, claimantId),
          eq(enrollments.courseId, seat.courseId)
        )
      )
      .get();
    if (existingEnrollment) {
      return { ok: false, error: "You are already enrolled in this course" };
    }

    const purchase = tx
      .select()
      .from(purchases)
      .where(eq(purchases.id, seat.purchaseId))
      .get();
    if (purchase?.country && purchase.country !== (claimantCountry ?? "")) {
      return {
        ok: false,
        error:
          "This coupon can only be redeemed from the same country as the purchaser",
      };
    }

    tx.update(coupons)
      .set({ redeemedByUserId: claimantId, redeemedAt: now.toISOString() })
      .where(eq(coupons.id, seat.id))
      .run();

    const enrollment = tx
      .insert(enrollments)
      .values({
        userId: claimantId,
        courseId: seat.courseId,
        enrolledAt: now.toISOString(),
      })
      .returning()
      .get();

    const claimant = getUser(tx, claimantId);
    const course = tx
      .select({ title: courses.title })
      .from(courses)
      .where(eq(courses.id, seat.courseId))
      .get();
    if (claimant && course) {
      enqueue(
        tx,
        [
          ...tellTeamAdmin(tx, purchase, seat.id, course.title, claimant),
          enrollmentWelcome(claimant, course),
        ],
        now
      );
    }

    return { ok: true, enrollmentId: enrollment.id, courseId: seat.courseId };
  });
}
