import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  coupons,
  courses,
  enrollments,
  purchases,
  teamMembers,
  teams,
  TeamMemberRole,
} from "~/db/schema";
import type { Db, Tx } from "~/db/types";
import {
  enrollmentWelcome,
  teamLicenceBoughtConfirmation,
} from "~/lib/confirmations.server";
import { purchaseMade, teamLicenceBought } from "~/lib/notify.server";
import { enqueue, type OutboxMessage } from "~/lib/outbox.server";
import { getUser, type User } from "~/lib/users.server";

// ─── Purchases ───
// Making an Individual Purchase and buying a Team Licence. See GLOSSARY.md for
// Purchase, Individual Purchase, Team Licence and Seat.
//
// Database first, positional parameters (project convention).

export type PurchaseResult =
  | { ok: true; purchaseId: number }
  | { ok: false; status: 404 | 409; error: string };

const COURSE_NOT_FOUND = {
  ok: false,
  status: 404,
  error: "Course not found.",
} as const;

const BUYER_NOT_FOUND = {
  ok: false,
  status: 404,
  error: "Buyer not found.",
} as const;

function getCourse(tx: Tx, courseId: number) {
  return tx.select().from(courses).where(eq(courses.id, courseId)).get();
}

type Course = NonNullable<ReturnType<typeof getCourse>>;
type Purchase = typeof purchases.$inferSelect;

/**
 * The course's Instructor hears about each Purchase of it, unless they are
 * the buyer.
 */
function tellInstructor(
  tx: Tx,
  course: Course,
  buyer: User,
  notification: (instructor: User) => OutboxMessage
): OutboxMessage[] {
  if (course.instructorId === buyer.id) return [];
  const instructor = getUser(tx, course.instructorId);
  return instructor ? [notification(instructor)] : [];
}

function coursePurchase(purchase: Purchase, course: Course) {
  return {
    id: purchase.id,
    amountPaid: purchase.amountPaid,
    courseId: course.id,
    courseTitle: course.title,
  };
}

function isEnrolled(tx: Tx, userId: number, courseId: number) {
  return !!tx
    .select({ id: enrollments.id })
    .from(enrollments)
    .where(
      and(eq(enrollments.userId, userId), eq(enrollments.courseId, courseId))
    )
    .get();
}

function recordPurchase(
  tx: Tx,
  buyerId: number,
  courseId: number,
  amountPaid: number,
  country: string | null,
  now: Date
) {
  return tx
    .insert(purchases)
    .values({
      userId: buyerId,
      courseId,
      amountPaid,
      country,
      createdAt: now.toISOString(),
    })
    .returning()
    .get();
}

/**
 * A Student buys a course for themselves: the Purchase and their Enrollment,
 * together. Refused when they are already enrolled.
 */
export function makeIndividualPurchase(
  db: Db,
  buyerId: number,
  courseId: number,
  amountPaid: number,
  country: string | null,
  now: Date
): PurchaseResult {
  return db.transaction((tx): PurchaseResult => {
    const course = getCourse(tx, courseId);
    const buyer = getUser(tx, buyerId);
    if (!course) return COURSE_NOT_FOUND;
    if (!buyer) return BUYER_NOT_FOUND;

    if (isEnrolled(tx, buyerId, course.id)) {
      return {
        ok: false,
        status: 409,
        error: "You are already enrolled in this course.",
      };
    }

    const purchase = recordPurchase(
      tx,
      buyerId,
      course.id,
      amountPaid,
      country,
      now
    );
    tx.insert(enrollments)
      .values({
        userId: buyerId,
        courseId: course.id,
        enrolledAt: now.toISOString(),
      })
      .run();

    enqueue(
      tx,
      [
        ...tellInstructor(tx, course, buyer, (instructor) =>
          purchaseMade(coursePurchase(purchase, course), buyer, instructor)
        ),
        enrollmentWelcome(buyer, course),
      ],
      now
    );

    return { ok: true, purchaseId: purchase.id };
  });
}

function getOrCreateTeamFor(tx: Tx, teamAdminId: number, now: Date) {
  const membership = tx
    .select({ teamId: teamMembers.teamId })
    .from(teamMembers)
    .where(
      and(
        eq(teamMembers.userId, teamAdminId),
        eq(teamMembers.role, TeamMemberRole.Admin)
      )
    )
    .get();
  if (membership) return membership.teamId;

  const team = tx
    .insert(teams)
    .values({ createdAt: now.toISOString() })
    .returning()
    .get();
  tx.insert(teamMembers)
    .values({
      teamId: team.id,
      userId: teamAdminId,
      role: TeamMemberRole.Admin,
      createdAt: now.toISOString(),
    })
    .run();
  return team.id;
}

/**
 * Someone buys `seatCount` Seats on a course for others, becoming the Team
 * Admin of their team. The buyer gets no Enrollment through it.
 */
export function buyTeamLicence(
  db: Db,
  buyerId: number,
  courseId: number,
  amountPaid: number,
  country: string | null,
  seatCount: number,
  now: Date
): PurchaseResult {
  return db.transaction((tx): PurchaseResult => {
    const course = getCourse(tx, courseId);
    const buyer = getUser(tx, buyerId);
    if (!course) return COURSE_NOT_FOUND;
    if (!buyer) return BUYER_NOT_FOUND;

    const purchase = recordPurchase(
      tx,
      buyerId,
      course.id,
      amountPaid,
      country,
      now
    );
    const teamId = getOrCreateTeamFor(tx, buyerId, now);
    tx.insert(coupons)
      .values(
        Array.from({ length: seatCount }, () => ({
          teamId,
          courseId: course.id,
          code: crypto.randomBytes(12).toString("base64url"),
          purchaseId: purchase.id,
        }))
      )
      .run();

    enqueue(
      tx,
      [
        ...tellInstructor(tx, course, buyer, (instructor) =>
          teamLicenceBought(
            coursePurchase(purchase, course),
            seatCount,
            buyer,
            instructor
          )
        ),
        teamLicenceBoughtConfirmation(buyer, course, seatCount, amountPaid),
      ],
      now
    );

    return { ok: true, purchaseId: purchase.id };
  });
}
