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

function addStudent(name: string) {
  return db
    .insert(schema.users)
    .values({
      name,
      email: `${name.toLowerCase()}@example.com`,
      role: UserRole.Student,
    })
    .returning()
    .get();
}

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

function outboxRows() {
  return db
    .select({
      kind: schema.outbox.kind,
      idempotencyKey: schema.outbox.idempotencyKey,
      payload: schema.outbox.payload,
      status: schema.outbox.status,
    })
    .from(schema.outbox)
    .orderBy(schema.outbox.id)
    .all();
}

describe("postComment's Notifications", () => {
  it("tells the course's Instructor about a Discussion Question", () => {
    const questionId = postOk(base.user.id, null, "How do I start?");

    expect(outboxRows()).toEqual([
      {
        kind: "suprsend_trigger",
        idempotencyKey: `question-asked:comment:${questionId}:user:${base.instructor.id}`,
        status: "pending",
        payload: {
          workflow: "question-asked",
          recipient: {
            distinct_id: String(base.instructor.id),
            name: "Test Instructor",
          },
          data: {
            course_title: "Test Course",
            lesson_title: "Lesson 1",
            asker_name: "Test User",
            excerpt: "How do I start?",
          },
          link: `/courses/test-course/lessons/${lessonId}#comment-${questionId}`,
        },
      },
    ]);
  });

  it("tells the asker about a Discussion Reply, linking to their question", () => {
    const questionId = postOk(base.user.id, null, "How do I start?");
    const replyId = postOk(base.instructor.id, questionId, "Open lesson 1.");

    expect(outboxRows().at(-1)).toEqual({
      kind: "suprsend_trigger",
      idempotencyKey: `reply-posted:comment:${replyId}:user:${base.user.id}`,
      status: "pending",
      payload: {
        workflow: "reply-posted",
        recipient: {
          distinct_id: String(base.user.id),
          name: "Test User",
        },
        data: {
          course_title: "Test Course",
          lesson_title: "Lesson 1",
          replier_name: "Test Instructor",
          excerpt: "Open lesson 1.",
        },
        link: `/courses/test-course/lessons/${lessonId}#comment-${questionId}`,
      },
    });
  });

  it("tells the asker about a Discussion Reply by another Student", () => {
    const questionId = postOk(base.user.id, null, "How do I start?");
    const classmate = addStudent("Sam");
    const replyId = postOk(classmate.id, questionId, "Same question!");

    expect(outboxRows().map((row) => row.idempotencyKey)).toEqual([
      `question-asked:comment:${questionId}:user:${base.instructor.id}`,
      `reply-posted:comment:${replyId}:user:${base.user.id}`,
    ]);
  });

  it("tells no one about the Instructor's own top-level comment", () => {
    postOk(base.instructor.id, null, "Welcome to the lesson!");

    expect(outboxRows()).toEqual([]);
  });

  it("tells no one when the asker replies to their own question", () => {
    const questionId = postOk(base.user.id, null, "How do I start?");
    postOk(base.user.id, questionId, "Never mind, found it.");

    expect(outboxRows().map((row) => row.payload)).toMatchObject([
      { workflow: "question-asked" },
    ]);
  });

  it("tells no one about a reply under the Instructor's own top-level comment", () => {
    const announcementId = postOk(base.instructor.id, null, "Welcome!");
    postOk(base.user.id, announcementId, "Thanks!");

    expect(outboxRows()).toEqual([]);
  });

  it("writes no row when the comment is refused", () => {
    const questionId = postOk(base.user.id, null, "How do I start?");
    const replyId = postOk(base.instructor.id, questionId, "Open lesson 1.");
    const before = outboxRows().length;

    post(base.user.id, replyId, "Thanks!");
    post(base.user.id, null, "   ");

    expect(outboxRows()).toHaveLength(before);
  });

  it("shortens a long comment to a one-line excerpt", () => {
    const body = `First line\n\n${"word ".repeat(60)}`;
    postOk(base.user.id, null, body);

    const [row] = outboxRows();
    expect(row.payload).toMatchObject({
      data: {
        // 139 characters, then the ellipsis.
        excerpt: `First line ${"word ".repeat(25)}wor…`,
      },
    });
  });
});
