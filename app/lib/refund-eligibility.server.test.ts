import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { getRefundEligibility } from "./refund-eligibility.server";

let testDb: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;

const TODAY = new Date(2026, 0, 2, 9, 0);
const YESTERDAY = new Date(2026, 0, 1, 9, 0);

beforeEach(() => {
  testDb = createTestDb();
  base = seedBaseData(testDb);
  testDb
    .update(schema.courses)
    .set({ price: 4900 })
    .run();
});

function buy(when: Date, amountPaid = 4900) {
  return testDb
    .insert(schema.purchases)
    .values({
      userId: base.user.id,
      courseId: base.course.id,
      amountPaid,
      country: "US",
      createdAt: when.toISOString(),
    })
    .returning()
    .get();
}

function addLesson(courseId = base.course.id) {
  const module = testDb
    .insert(schema.modules)
    .values({ courseId, title: "Module", position: 1 })
    .returning()
    .get();
  return testDb
    .insert(schema.lessons)
    .values({ moduleId: module.id, title: "Lesson", position: 1 })
    .returning()
    .get();
}

function watch(lessonId: number, positionSeconds: number) {
  testDb
    .insert(schema.videoWatchEvents)
    .values({
      userId: base.user.id,
      lessonId,
      eventType: "progress",
      positionSeconds,
    })
    .run();
}

function complete(lessonId: number) {
  testDb
    .insert(schema.lessonProgress)
    .values({
      userId: base.user.id,
      lessonId,
      status: schema.LessonProgressStatus.Completed,
    })
    .run();
}

function eligibility() {
  return getRefundEligibility(base.user.id, base.course.id, TODAY, testDb);
}

const HOUR = 60 * 60;

describe("getRefundEligibility", () => {
  it("refuses a learner who never bought the course", () => {
    expect(eligibility()).toEqual({ eligible: false, reason: "not-purchased" });
  });

  it("offers a refund at the course price to a learner who bought it yesterday", () => {
    const purchase = buy(YESTERDAY);

    expect(eligibility()).toEqual({
      eligible: true,
      amount: 4900,
      lastDayInWindow: "2026-01-15",
      purchaseId: purchase.id,
    });
  });

  describe("watch time", () => {
    it("adds up the furthest point reached in each lesson, not every event", () => {
      buy(YESTERDAY);
      const first = addLesson();
      const second = addLesson();
      // Rewatching the first hour of a lesson three times is still one hour.
      watch(first.id, HOUR);
      watch(first.id, HOUR);
      watch(first.id, HOUR);
      watch(second.id, HOUR - 1);

      expect(eligibility().eligible).toBe(true);

      watch(second.id, HOUR);
      expect(eligibility()).toEqual({
        eligible: false,
        reason: "watched-too-much",
      });
    });

    it("ignores what the learner watched in other courses", () => {
      buy(YESTERDAY);
      addLesson();
      const otherCourse = testDb
        .insert(schema.courses)
        .values({
          title: "Other",
          slug: "other",
          description: "Other",
          salesCopy: "Other",
          instructorId: base.instructor.id,
          categoryId: base.category.id,
          status: schema.CourseStatus.Published,
        })
        .returning()
        .get();
      watch(addLesson(otherCourse.id).id, 3 * HOUR);

      expect(eligibility().eligible).toBe(true);
    });
  });

  it("refuses a learner who has completed half the lessons", () => {
    // The request action used to skip this check (#3).
    buy(YESTERDAY);
    const first = addLesson();
    addLesson();
    complete(first.id);

    expect(eligibility()).toEqual({
      eligible: false,
      reason: "completed-too-much",
    });
  });

  describe("after a Refund and a second purchase", () => {
    it("still counts what the learner watched under the first purchase", () => {
      buy(new Date(2025, 5, 1));
      const lesson = addLesson();
      watch(lesson.id, 2 * HOUR);
      buy(YESTERDAY);

      expect(eligibility()).toEqual({
        eligible: false,
        reason: "watched-too-much",
      });
    });

    it("runs the window from the latest purchase", () => {
      buy(new Date(2025, 5, 1));
      buy(YESTERDAY);

      expect(eligibility()).toMatchObject({
        eligible: true,
        lastDayInWindow: "2026-01-15",
      });
    });
  });

  describe("the Refund amount", () => {
    it("is what the learner paid, after the course price went up", () => {
      buy(YESTERDAY, 4900);
      testDb.update(schema.courses).set({ price: 9900 }).run();

      expect(eligibility()).toMatchObject({ eligible: true, amount: 4900 });
    });

    it("is what the learner paid, after the course price came down", () => {
      buy(YESTERDAY, 4900);
      testDb.update(schema.courses).set({ price: 2900 }).run();

      expect(eligibility()).toMatchObject({ eligible: true, amount: 4900 });
    });
  });
});
