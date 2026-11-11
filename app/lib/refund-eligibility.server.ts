import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  coupons,
  lessonProgress,
  LessonProgressStatus,
  lessons,
  modules,
  purchases,
  refundRequests,
  RefundRequestStatus,
  videoWatchEvents,
} from "~/db/schema";
import {
  decideRefundEligibility,
  type RefundRefusal,
} from "./refund-eligibility";

type Database = typeof db;

export type LearnerRefundEligibility =
  | {
      eligible: true;
      amount: number;
      lastDayInWindow: string;
      /** The purchase a Refund Request would be made against. */
      purchaseId: number;
    }
  | { eligible: false; reason: RefundRefusal | "not-purchased" };

/**
 * Whether this learner may make a Refund Request on this course today, and
 * what their Refund would be.
 *
 * Watch time and completion count everything the learner has done in the
 * course, under any purchase of it: a learner who was refunded and bought the
 * course again does not start from zero. The window runs from the latest
 * purchase.
 */
export function getRefundEligibility(
  userId: number,
  courseId: number,
  today: Date = new Date(),
  database: Database = db
): LearnerRefundEligibility {
  const purchase = database
    .select()
    .from(purchases)
    .where(and(eq(purchases.userId, userId), eq(purchases.courseId, courseId)))
    .orderBy(sql`${purchases.createdAt} desc`)
    .get();

  if (!purchase) {
    return { eligible: false, reason: "not-purchased" };
  }

  const decision = decideRefundEligibility(
    {
      purchasedAt: purchase.createdAt,
      amountPaid: purchase.amountPaid,
      ...getCourseActivity(userId, courseId, database),
      isClaimedTeamSeat: hasClaimedSeat(database, purchase.id),
      hasPendingRequest: hasPendingRequest(database, purchase.id),
    },
    today
  );

  return decision.eligible
    ? { ...decision, purchaseId: purchase.id }
    : decision;
}

/**
 * How much of the course this learner has watched and completed, under any
 * purchase of it. The refund limits are measured against this.
 */
export function getCourseActivity(
  userId: number,
  courseId: number,
  database: Database = db
) {
  const lessonIds = database
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all()
    .map((row) => row.id);

  return {
    secondsWatched: getSecondsWatched(database, userId, lessonIds),
    completedLessons: getCompletedLessonCount(database, userId, lessonIds),
    totalLessons: lessonIds.length,
  };
}

// Watch time is the furthest point reached in each lesson, added up — not
// the raw number of events, which would count rewatching twice.
function getSecondsWatched(
  database: Database,
  userId: number,
  lessonIds: number[]
) {
  if (lessonIds.length === 0) return 0;

  return database
    .select({
      furthest: sql<number>`max(${videoWatchEvents.positionSeconds})`,
    })
    .from(videoWatchEvents)
    .where(
      and(
        eq(videoWatchEvents.userId, userId),
        inArray(videoWatchEvents.lessonId, lessonIds)
      )
    )
    .groupBy(videoWatchEvents.lessonId)
    .all()
    .reduce((total, row) => total + row.furthest, 0);
}

function getCompletedLessonCount(
  database: Database,
  userId: number,
  lessonIds: number[]
) {
  if (lessonIds.length === 0) return 0;

  const result = database
    .select({ count: sql<number>`count(*)` })
    .from(lessonProgress)
    .where(
      and(
        eq(lessonProgress.userId, userId),
        eq(lessonProgress.status, LessonProgressStatus.Completed),
        inArray(lessonProgress.lessonId, lessonIds)
      )
    )
    .get();

  return result?.count ?? 0;
}

function hasClaimedSeat(database: Database, purchaseId: number) {
  return !!database
    .select({ id: coupons.id })
    .from(coupons)
    .where(
      and(eq(coupons.purchaseId, purchaseId), isNotNull(coupons.redeemedAt))
    )
    .get();
}

function hasPendingRequest(database: Database, purchaseId: number) {
  return !!database
    .select({ id: refundRequests.id })
    .from(refundRequests)
    .where(
      and(
        eq(refundRequests.purchaseId, purchaseId),
        eq(refundRequests.status, RefundRequestStatus.Pending)
      )
    )
    .get();
}
