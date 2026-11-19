import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { UserRole } from "~/db/schema";
import { postComment } from "./discussions.server";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date("2026-10-06T12:00:00.000Z");

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;
let lessonId: number;
let otherLessonId: number;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);

  const module = db
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Basics", position: 1 })
    .returning()
    .get();

  [lessonId, otherLessonId] = [1, 2].map(
    (position) =>
      db
        .insert(schema.lessons)
        .values({ moduleId: module.id, title: `Lesson ${position}`, position })
        .returning()
        .get().id
  );
});

function getComment(id: number) {
  return db
    .select()
    .from(schema.comments)
    .where(eq(schema.comments.id, id))
    .get();
}

function post(
  authorId: number,
  parentId: number | null,
  body: string,
  lesson = lessonId
) {
  return postComment(db, authorId, lesson, parentId, body, NOW);
}

function postOk(authorId: number, parentId: number | null, body: string) {
  const result = post(authorId, parentId, body);
  if (!result.ok) throw new Error(result.error);
  return result.commentId;
}

describe("postComment", () => {
  it("saves a top-level comment with its body trimmed", () => {
    const result = post(base.user.id, null, "  How do I start?  ");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(getComment(result.commentId)).toMatchObject({
      userId: base.user.id,
      lessonId,
      parentId: null,
      body: "How do I start?",
      createdAt: NOW.toISOString(),
    });
  });

  it("saves a reply under a top-level comment", () => {
    const questionId = postOk(base.user.id, null, "How do I start?");

    const result = post(base.instructor.id, questionId, "Open lesson 1.");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(getComment(result.commentId)).toMatchObject({
      userId: base.instructor.id,
      lessonId,
      parentId: questionId,
      body: "Open lesson 1.",
    });
  });

  it("refuses a reply to a reply, since replies are one level deep", () => {
    const questionId = postOk(base.user.id, null, "How do I start?");
    const replyId = postOk(base.instructor.id, questionId, "Open lesson 1.");

    expect(post(base.user.id, replyId, "Thanks!")).toEqual({
      ok: false,
      status: 400,
      error: "Replies can only be one level deep",
    });
  });

  it("refuses a reply whose parent is missing or on another lesson", () => {
    const elsewhereId = postOk(base.user.id, null, "How do I start?");

    expect(post(base.user.id, 999, "Hello")).toEqual({
      ok: false,
      status: 404,
      error: "Parent comment not found",
    });
    expect(post(base.user.id, elsewhereId, "Hello", otherLessonId)).toEqual({
      ok: false,
      status: 400,
      error: "Parent comment belongs to a different lesson",
    });
  });

  it("refuses an empty or overlong body, and a missing lesson", () => {
    expect(post(base.user.id, null, "   ")).toEqual({
      ok: false,
      status: 400,
      error: "Comment cannot be empty",
    });
    expect(post(base.user.id, null, "x".repeat(5001))).toEqual({
      ok: false,
      status: 400,
      error: "Comment must be 5000 characters or fewer",
    });
    expect(post(base.user.id, null, "Hello", 999)).toEqual({
      ok: false,
      status: 404,
      error: "Lesson not found",
    });
    expect(db.select().from(schema.comments).all()).toEqual([]);
  });
});
