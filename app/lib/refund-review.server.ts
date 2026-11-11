// ─── Refund Request review ───
// What happens when an Admin Approves or Declines a Refund Request.

import { and, asc, desc, eq, ne } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { db } from "~/db";
import { formatPrice } from "~/lib/utils";
import { daysLeftInWindow } from "~/lib/refund-eligibility";
import { getCourseActivity } from "~/lib/refund-eligibility.server";
import {
  courseRatings,
  courses,
  enrollments,
  purchases,
  refundRequests,
  RefundRequestStatus,
  UserRole,
  users,
} from "~/db/schema";

type Database = typeof db;

export type ReviewRefusal =
  | "not-admin"
  | "not-found"
  | "not-pending"
  | "note-required";

/** A message for the learner. No mail transport yet: routes log it. */
export type Email = { to: string; subject: string; body: string };

export type ReviewResult =
  | { ok: true; email: Email }
  | { ok: false; reason: ReviewRefusal };

/**
 * An Admin Approves a Pending Refund Request. The Refund is recorded as
 * exactly what the learner paid, and they lose access to the course at once.
 */
export function approveRefundRequest(
  requestId: number,
  adminUserId: number,
  now: Date = new Date(),
  database: Database = db
): ReviewResult {
  const loaded = loadForReview(database, requestId, adminUserId);
  if (!loaded.ok) return loaded;
  const { request } = loaded;

  const ofThisLearnerAndCourse = <
    T extends typeof enrollments | typeof courseRatings,
  >(
    table: T
  ) =>
    and(
      eq(table.userId, request.learnerId),
      eq(table.courseId, request.courseId)
    );

  database.transaction((tx) => {
    tx.update(refundRequests)
      .set({
        status: RefundRequestStatus.Approved,
        amountRefunded: request.amountPaid,
        resolvedAt: now.toISOString(),
        resolvedByUserId: adminUserId,
      })
      .where(eq(refundRequests.id, requestId))
      .run();

    // Access ends the moment the Refund is recorded. Their rating goes too —
    // a star rating implies they own the course. Progress, watch history,
    // quiz attempts and comments are kept on purpose: see ADR 0001.
    tx.delete(enrollments).where(ofThisLearnerAndCourse(enrollments)).run();
    tx.delete(courseRatings).where(ofThisLearnerAndCourse(courseRatings)).run();
  });

  return {
    ok: true,
    email: {
      to: request.learnerEmail,
      subject: `Your refund for ${request.courseTitle}`,
      body: [
        `Hi ${request.learnerName},`,
        "",
        `We have approved your refund request: you will get back ${formatPrice(request.amountPaid)}, the full amount you paid.`,
        "",
        `You no longer have access to ${request.courseTitle}. If you ever come back to it, your progress is saved and you can pick up where you left off.`,
        "",
        "— The Cadence team",
      ].join("\n"),
    },
  };
}

/**
 * An Admin Declines a Pending Refund Request. The learner keeps the course,
 * and is always told why.
 */
export function declineRefundRequest(
  requestId: number,
  adminUserId: number,
  note: string,
  now: Date = new Date(),
  database: Database = db
): ReviewResult {
  const loaded = loadForReview(database, requestId, adminUserId);
  if (!loaded.ok) return loaded;
  const { request } = loaded;

  const declineNote = note.trim();
  if (!declineNote) return { ok: false, reason: "note-required" };

  database
    .update(refundRequests)
    .set({
      status: RefundRequestStatus.Declined,
      declineNote,
      resolvedAt: now.toISOString(),
      resolvedByUserId: adminUserId,
    })
    .where(eq(refundRequests.id, requestId))
    .run();

  return {
    ok: true,
    email: {
      to: request.learnerEmail,
      subject: `Your refund request for ${request.courseTitle}`,
      body: [
        `Hi ${request.learnerName},`,
        "",
        `We have looked at your refund request for "${request.courseTitle}" and are not able to give a refund. Here is why:`,
        "",
        declineNote,
        "",
        "You still have full access to the course.",
        "",
        "— The Cadence team",
      ].join("\n"),
    },
  };
}

export type RefundRequestTab = "pending" | "resolved";

/**
 * The Refund Requests an Admin works through. Pending ones come oldest
 * first, so nobody waits longest; resolved ones come newest decision first.
 *
 * Each row carries the facts as they stood when the learner asked (days left
 * in the window) next to how much of the course they have used since, which
 * informs the Admin's decision but never blocks it.
 */
export function listRefundRequests(
  tab: RefundRequestTab,
  database: Database = db
) {
  const resolver = alias(users, "resolver");

  const rows = database
    .select({
      id: refundRequests.id,
      status: refundRequests.status,
      reason: refundRequests.reason,
      requestedAt: refundRequests.requestedAt,
      declineNote: refundRequests.declineNote,
      amountRefunded: refundRequests.amountRefunded,
      resolvedAt: refundRequests.resolvedAt,
      resolvedByName: resolver.name,
      amount: purchases.amountPaid,
      purchasedAt: purchases.createdAt,
      learnerId: users.id,
      learnerName: users.name,
      learnerEmail: users.email,
      courseId: courses.id,
      courseTitle: courses.title,
      courseSlug: courses.slug,
    })
    .from(refundRequests)
    .innerJoin(purchases, eq(refundRequests.purchaseId, purchases.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .leftJoin(resolver, eq(refundRequests.resolvedByUserId, resolver.id))
    .where(
      tab === "pending"
        ? eq(refundRequests.status, RefundRequestStatus.Pending)
        : ne(refundRequests.status, RefundRequestStatus.Pending)
    )
    .orderBy(
      tab === "pending"
        ? asc(refundRequests.requestedAt)
        : desc(refundRequests.resolvedAt)
    )
    .all();

  return rows.map((row) => ({
    ...row,
    daysLeftInWindowWhenAsked: daysLeftInWindow(
      row.purchasedAt,
      new Date(row.requestedAt)
    ),
    ...getCourseActivity(row.learnerId, row.courseId, database),
  }));
}

/**
 * The checks both decisions share: only an Admin may review — never the
 * course's own instructor — and only a request that is still Pending.
 */
function loadForReview(
  database: Database,
  requestId: number,
  adminUserId: number
) {
  const reviewer = database
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, adminUserId))
    .get();

  if (reviewer?.role !== UserRole.Admin) {
    return { ok: false as const, reason: "not-admin" as const };
  }

  const request = database
    .select({
      status: refundRequests.status,
      amountPaid: purchases.amountPaid,
      learnerId: purchases.userId,
      courseId: purchases.courseId,
      courseTitle: courses.title,
      learnerName: users.name,
      learnerEmail: users.email,
    })
    .from(refundRequests)
    .innerJoin(purchases, eq(refundRequests.purchaseId, purchases.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .where(eq(refundRequests.id, requestId))
    .get();

  if (!request) return { ok: false as const, reason: "not-found" as const };
  if (request.status !== RefundRequestStatus.Pending) {
    return { ok: false as const, reason: "not-pending" as const };
  }

  return { ok: true as const, request };
}
