import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import {
  approveRefundRequest,
  declineRefundRequest,
  listRefundRequests,
} from "./refund-review.server";

let testDb: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;
let admin: typeof schema.users.$inferSelect;

const NOW = new Date(2026, 0, 5, 10, 0);

beforeEach(() => {
  testDb = createTestDb();
  base = seedBaseData(testDb);
  admin = testDb
    .insert(schema.users)
    .values({
      name: "Ada Admin",
      email: "admin@example.com",
      role: schema.UserRole.Admin,
    })
    .returning()
    .get();
});

/** A learner who bought the course, enrolled, and asked for their money back. */
function pendingRequest({
  amountPaid = 4900,
  requestedAt = new Date(2026, 0, 3, 9, 0),
  userId = base.user.id,
} = {}) {
  const purchase = testDb
    .insert(schema.purchases)
    .values({
      userId,
      courseId: base.course.id,
      amountPaid,
      country: "US",
      createdAt: new Date(2026, 0, 1, 9, 0).toISOString(),
    })
    .returning()
    .get();
  testDb
    .insert(schema.enrollments)
    .values({ userId, courseId: base.course.id })
    .run();
  return testDb
    .insert(schema.refundRequests)
    .values({
      purchaseId: purchase.id,
      reason: "The course was not what I expected.",
      requestedAt: requestedAt.toISOString(),
    })
    .returning()
    .get();
}

type LearnerTable =
  | typeof schema.enrollments
  | typeof schema.courseRatings
  | typeof schema.lessonProgress
  | typeof schema.videoWatchEvents
  | typeof schema.quizAttempts
  | typeof schema.comments;

/** How many rows this learner has in a table they own rows in. */
function rowsFor(table: LearnerTable) {
  return testDb
    .select({ userId: table.userId })
    .from(table as typeof schema.enrollments)
    .where(eq(table.userId, base.user.id))
    .all().length;
}

/** The learner has rated the course and worked through some of it. */
function learnerActivity() {
  const module = testDb
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Module", position: 1 })
    .returning()
    .get();
  const lesson = testDb
    .insert(schema.lessons)
    .values({ moduleId: module.id, title: "Lesson", position: 1 })
    .returning()
    .get();
  const quiz = testDb
    .insert(schema.quizzes)
    .values({ lessonId: lesson.id, title: "Quiz", passingScore: 0.7 })
    .returning()
    .get();
  const learner = base.user.id;

  testDb.insert(schema.courseRatings).values({ userId: learner, courseId: base.course.id, rating: 1 }).run();
  testDb.insert(schema.lessonProgress).values({ userId: learner, lessonId: lesson.id, status: schema.LessonProgressStatus.Completed }).run();
  testDb.insert(schema.videoWatchEvents).values({ userId: learner, lessonId: lesson.id, eventType: "progress", positionSeconds: 300 }).run();
  testDb.insert(schema.quizAttempts).values({ userId: learner, quizId: quiz.id, score: 0.5, passed: false }).run();
  testDb.insert(schema.comments).values({ userId: learner, lessonId: lesson.id, body: "Good question" }).run();
}

function reload(requestId: number) {
  return testDb
    .select()
    .from(schema.refundRequests)
    .where(eq(schema.refundRequests.id, requestId))
    .get()!;
}

describe("approveRefundRequest", () => {
  it("records a Refund of exactly what the learner paid", () => {
    const request = pendingRequest({ amountPaid: 2450 });

    const result = approveRefundRequest(request.id, admin.id, NOW, testDb);

    expect(result.ok).toBe(true);
    expect(reload(request.id)).toMatchObject({
      status: schema.RefundRequestStatus.Approved,
      amountRefunded: 2450,
      resolvedAt: NOW.toISOString(),
      resolvedByUserId: admin.id,
    });
  });

  it("ends the learner's access and removes their rating", () => {
    const request = pendingRequest();
    learnerActivity();

    approveRefundRequest(request.id, admin.id, NOW, testDb);

    expect(rowsFor(schema.enrollments)).toBe(0);
    expect(rowsFor(schema.courseRatings)).toBe(0);
  });

  it("keeps the learner's progress and comments (ADR 0001)", () => {
    const request = pendingRequest();
    learnerActivity();

    approveRefundRequest(request.id, admin.id, NOW, testDb);

    expect(rowsFor(schema.lessonProgress)).toBe(1);
    expect(rowsFor(schema.videoWatchEvents)).toBe(1);
    expect(rowsFor(schema.quizAttempts)).toBe(1);
    expect(rowsFor(schema.comments)).toBe(1);
  });

  it("emails the learner their Refund, that access has ended, and that their progress is saved", () => {
    const request = pendingRequest({ amountPaid: 2450 });

    const result = approveRefundRequest(request.id, admin.id, NOW, testDb);

    expect(result.ok && result.email.to).toBe("test@example.com");
    expect(result.ok && result.email.subject).toBe(
      "Your refund for Test Course"
    );
    const body = result.ok ? result.email.body : "";
    expect(body).toContain("$24.50");
    expect(body).toContain("no longer have access to Test Course");
    expect(body).toContain("your progress is saved");
  });

  describe("refuses, and changes nothing", () => {
    it("when the reviewer is not an Admin, even the course's instructor", () => {
      const request = pendingRequest();

      expect(
        approveRefundRequest(request.id, base.instructor.id, NOW, testDb)
      ).toEqual({ ok: false, reason: "not-admin" });
      expect(reload(request.id).status).toBe(schema.RefundRequestStatus.Pending);
      expect(rowsFor(schema.enrollments)).toBe(1);
    });

    it("when the request is no longer Pending", () => {
      const request = pendingRequest();
      approveRefundRequest(request.id, admin.id, NOW, testDb);
      // Buying again re-enrolls them; approving the old request twice must
      // not take that new access away.
      testDb
        .insert(schema.enrollments)
        .values({ userId: base.user.id, courseId: base.course.id })
        .run();

      expect(approveRefundRequest(request.id, admin.id, NOW, testDb)).toEqual({
        ok: false,
        reason: "not-pending",
      });
      expect(rowsFor(schema.enrollments)).toBe(1);
    });

    it("when there is no such request", () => {
      expect(approveRefundRequest(999, admin.id, NOW, testDb)).toEqual({
        ok: false,
        reason: "not-found",
      });
    });
  });
});

describe("declineRefundRequest", () => {
  const NOTE = "You have already finished most of the course.";

  it("records the decision and the Admin's note, with no Refund", () => {
    const request = pendingRequest();

    const result = declineRefundRequest(request.id, admin.id, NOTE, NOW, testDb);

    expect(result.ok).toBe(true);
    expect(reload(request.id)).toMatchObject({
      status: schema.RefundRequestStatus.Declined,
      declineNote: NOTE,
      amountRefunded: null,
      resolvedAt: NOW.toISOString(),
      resolvedByUserId: admin.id,
    });
  });

  it("leaves the learner with the course and their rating", () => {
    const request = pendingRequest();
    learnerActivity();

    declineRefundRequest(request.id, admin.id, NOTE, NOW, testDb);

    expect(rowsFor(schema.enrollments)).toBe(1);
    expect(rowsFor(schema.courseRatings)).toBe(1);
  });

  it("emails the learner the Admin's note", () => {
    const request = pendingRequest();

    const result = declineRefundRequest(request.id, admin.id, NOTE, NOW, testDb);

    expect(result.ok && result.email.to).toBe("test@example.com");
    expect(result.ok && result.email.subject).toBe(
      "Your refund request for Test Course"
    );
    expect(result.ok && result.email.body).toContain(NOTE);
  });

  describe("refuses, and changes nothing", () => {
    it("without a note", () => {
      const request = pendingRequest();

      expect(
        declineRefundRequest(request.id, admin.id, "   ", NOW, testDb)
      ).toEqual({ ok: false, reason: "note-required" });
      expect(reload(request.id).status).toBe(schema.RefundRequestStatus.Pending);
    });

    it("when the reviewer is not an Admin", () => {
      const request = pendingRequest();

      expect(
        declineRefundRequest(request.id, base.instructor.id, NOTE, NOW, testDb)
      ).toEqual({ ok: false, reason: "not-admin" });
      expect(reload(request.id).status).toBe(schema.RefundRequestStatus.Pending);
    });

    it("when the request has already been Approved", () => {
      const request = pendingRequest();
      approveRefundRequest(request.id, admin.id, NOW, testDb);

      expect(
        declineRefundRequest(request.id, admin.id, NOTE, NOW, testDb)
      ).toEqual({ ok: false, reason: "not-pending" });
      expect(reload(request.id).status).toBe(
        schema.RefundRequestStatus.Approved
      );
    });
  });
});

describe("listRefundRequests", () => {
  function anotherLearner(name: string) {
    return testDb
      .insert(schema.users)
      .values({
        name,
        email: `${name.toLowerCase()}@example.com`,
        role: schema.UserRole.Student,
      })
      .returning()
      .get();
  }

  it("lists Pending requests oldest first, leaving resolved ones out", () => {
    const newer = pendingRequest({ requestedAt: new Date(2026, 0, 4) });
    const older = pendingRequest({
      requestedAt: new Date(2026, 0, 2),
      userId: anotherLearner("Bea").id,
    });
    const resolved = pendingRequest({
      requestedAt: new Date(2026, 0, 1, 12),
      userId: anotherLearner("Cy").id,
    });
    approveRefundRequest(resolved.id, admin.id, NOW, testDb);

    expect(
      listRefundRequests("pending", testDb).map((row) => row.id)
    ).toEqual([older.id, newer.id]);
  });

  it("shows what the Admin needs to decide", () => {
    // Bought 1 January, so the last day of the window is 15 January.
    // Asked on 3 January, with 12 days of the window left.
    pendingRequest({ amountPaid: 2450, requestedAt: new Date(2026, 0, 3, 9) });
    learnerActivity();

    expect(listRefundRequests("pending", testDb)).toEqual([
      expect.objectContaining({
        learnerName: "Test User",
        courseTitle: "Test Course",
        amount: 2450,
        reason: "The course was not what I expected.",
        daysLeftInWindowWhenAsked: 12,
        secondsWatched: 300,
        completedLessons: 1,
        totalLessons: 1,
      }),
    ]);
  });

  it("lists resolved requests with the decision, newest decision first", () => {
    const approved = pendingRequest();
    const declined = pendingRequest({ userId: anotherLearner("Bea").id });
    approveRefundRequest(approved.id, admin.id, NOW, testDb);
    declineRefundRequest(
      declined.id,
      admin.id,
      "Most of the course is already watched.",
      new Date(2026, 0, 6),
      testDb
    );

    expect(listRefundRequests("resolved", testDb)).toEqual([
      expect.objectContaining({
        id: declined.id,
        status: schema.RefundRequestStatus.Declined,
        declineNote: "Most of the course is already watched.",
        amountRefunded: null,
        resolvedByName: "Ada Admin",
      }),
      expect.objectContaining({
        id: approved.id,
        status: schema.RefundRequestStatus.Approved,
        amountRefunded: 4900,
        resolvedByName: "Ada Admin",
      }),
    ]);
  });
});
