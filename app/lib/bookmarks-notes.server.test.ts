import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { UserRole } from "~/db/schema";
import { approveRefundRequest, raiseRefundRequest } from "./refunds.server";
import {
  canBookmarkAndNote,
  getNote,
  isBookmarked,
  listBookmarks,
  listNotes,
  MAX_NOTE_LENGTH,
  saveNote,
  toggleBookmark,
} from "./bookmarks-notes.server";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date("2026-10-06T12:00:00.000Z");
const LATER = new Date("2026-10-06T13:00:00.000Z");
const LATEST = new Date("2026-10-06T14:00:00.000Z");

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;
let lessonIds: number[];

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);

  const module = db
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Basics", position: 1 })
    .returning()
    .get();

  lessonIds = [1, 2].map(
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

describe("Bookmarks", () => {
  it("bookmarks a Lesson, and toggling again removes the Bookmark", () => {
    const [lessonId] = lessonIds;

    expect(toggleBookmark(db, base.user.id, lessonId, NOW)).toBe(true);
    expect(isBookmarked(db, base.user.id, lessonId)).toBe(true);

    expect(toggleBookmark(db, base.user.id, lessonId, LATER)).toBe(false);
    expect(isBookmarked(db, base.user.id, lessonId)).toBe(false);
  });

  it("never leaves a Student two Bookmarks on one Lesson", () => {
    const [lessonId] = lessonIds;

    toggleBookmark(db, base.user.id, lessonId, NOW);
    toggleBookmark(db, base.user.id, lessonId, LATER);
    toggleBookmark(db, base.user.id, lessonId, LATEST);

    expect(listBookmarks(db, base.user.id)).toHaveLength(1);
    expect(() =>
      db
        .insert(schema.bookmarks)
        .values({ userId: base.user.id, lessonId })
        .run()
    ).toThrow(/UNIQUE/);
  });
});

describe("Notes", () => {
  it("saves a Note, and saving again replaces it and moves 'last edited' on", () => {
    const [lessonId] = lessonIds;

    expect(saveNote(db, base.user.id, lessonId, "  First thought ", NOW)).toEqual(
      { ok: true }
    );
    expect(getNote(db, base.user.id, lessonId)).toEqual({
      body: "First thought",
      updatedAt: NOW.toISOString(),
    });

    saveNote(db, base.user.id, lessonId, "Second thought", LATER);

    expect(getNote(db, base.user.id, lessonId)).toEqual({
      body: "Second thought",
      updatedAt: LATER.toISOString(),
    });
    expect(listNotes(db, base.user.id)).toHaveLength(1);
  });

  it("refuses a Note over 2,000 characters, and accepts one of exactly 2,000", () => {
    const [lessonId] = lessonIds;
    expect(MAX_NOTE_LENGTH).toBe(2000);

    expect(saveNote(db, base.user.id, lessonId, "x".repeat(2001), NOW)).toEqual({
      ok: false,
      error: "A note can be at most 2,000 characters.",
    });
    expect(getNote(db, base.user.id, lessonId)).toBeUndefined();

    expect(saveNote(db, base.user.id, lessonId, "x".repeat(2000), NOW)).toEqual({
      ok: true,
    });
  });

  it("deletes the Note when it is saved empty", () => {
    saveNote(db, base.user.id, lessonIds[0], "Soon gone", NOW);

    expect(saveNote(db, base.user.id, lessonIds[0], "   ", LATER)).toEqual({
      ok: true,
    });
    expect(getNote(db, base.user.id, lessonIds[0])).toBeUndefined();
    expect(listNotes(db, base.user.id)).toEqual([]);
  });

  it("saving an empty box with no Note changes nothing", () => {
    expect(saveNote(db, base.user.id, lessonIds[0], "", NOW)).toEqual({ ok: true });
    expect(getNote(db, base.user.id, lessonIds[0])).toBeUndefined();
  });

  it("keeps a Note as plain text, exactly as typed", () => {
    saveNote(db, base.user.id, lessonIds[0], "# Not a heading\n*not bold*", NOW);

    expect(getNote(db, base.user.id, lessonIds[0])?.body).toBe(
      "# Not a heading\n*not bold*"
    );
  });
});

describe("the Saved lists", () => {
  it("hold only this Student's rows, newest first, each with its Lesson and Course", () => {
    const other = addStudent("Olive");
    const [first, second] = lessonIds;
    toggleBookmark(db, base.user.id, first, NOW);
    toggleBookmark(db, base.user.id, second, LATER);
    toggleBookmark(db, other.id, first, LATEST);
    saveNote(db, base.user.id, first, "On lesson one", LATER);
    saveNote(db, base.user.id, second, "On lesson two", NOW);
    saveNote(db, other.id, first, "Olive's note", LATEST);

    expect(listBookmarks(db, base.user.id)).toEqual([
      expect.objectContaining({
        lessonId: second,
        lessonTitle: "Lesson 2",
        courseTitle: "Test Course",
        courseSlug: "test-course",
      }),
      expect.objectContaining({ lessonId: first, lessonTitle: "Lesson 1" }),
    ]);
    expect(listNotes(db, base.user.id)).toEqual([
      expect.objectContaining({
        lessonId: first,
        body: "On lesson one",
        courseTitle: "Test Course",
      }),
      expect.objectContaining({ lessonId: second, body: "On lesson two" }),
    ]);
  });
});

describe("an approved Refund", () => {
  it("keeps the Student's Bookmarks and Notes", () => {
    const admin = db
      .insert(schema.users)
      .values({ name: "Pat Admin", email: "pat@example.com", role: UserRole.Admin })
      .returning()
      .get();
    const purchase = db
      .insert(schema.purchases)
      .values({
        userId: base.user.id,
        courseId: base.course.id,
        amountPaid: 7900,
        createdAt: new Date("2026-10-03T12:00:00.000Z").toISOString(),
      })
      .returning()
      .get();
    db.insert(schema.enrollments)
      .values({ userId: base.user.id, courseId: base.course.id })
      .run();
    toggleBookmark(db, base.user.id, lessonIds[0], NOW);
    saveNote(db, base.user.id, lessonIds[0], "Keep me", NOW);

    const raised = raiseRefundRequest(db, purchase.id, base.user.id, "Not for me.", NOW);
    if (!raised.ok) throw new Error(raised.error);
    expect(
      approveRefundRequest(db, raised.refundRequestId, admin.id, null, NOW)
    ).toEqual({ ok: true });

    expect(isBookmarked(db, base.user.id, lessonIds[0])).toBe(true);
    expect(getNote(db, base.user.id, lessonIds[0])?.body).toBe("Keep me");
  });
});

// Bookmarks and Notes belong to Students taking the Course: access through
// the person's own Enrollment, not through being its Instructor or an admin.
describe("who can bookmark and write Notes", () => {
  it("is a Student whose Enrollment gives them the Course's content", () => {
    expect(canBookmarkAndNote({ enrolled: true, pppBlocked: false })).toBe(true);
  });

  it("is not staff without an Enrollment, nor a Student blocked by regional pricing", () => {
    expect(canBookmarkAndNote({ enrolled: false, pppBlocked: false })).toBe(false);
    expect(canBookmarkAndNote({ enrolled: true, pppBlocked: true })).toBe(false);
  });
});
