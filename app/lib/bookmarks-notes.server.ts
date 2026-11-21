import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { bookmarks, courses, lessons, modules, notes } from "~/db/schema";
import type { Db } from "~/db/types";
import type { Access } from "~/lib/access.server";

// ─── Bookmarks and Notes ───
// What a Student attaches to a Lesson for themselves. See GLOSSARY.md: a Note
// is private to the Student who wrote it, so nothing outside the Student's own
// Lesson page and Saved page may read one. "One per Student per Lesson" is
// held by the unique indexes, not by these functions alone.
//
// Database first, positional parameters (project convention).

export const MAX_NOTE_LENGTH = 2000;

/**
 * A Note body as typed: plain text, trimmed, never rendered as Markdown. An
 * empty body means "no Note".
 */
export const noteBodySchema = z
  .string()
  .trim()
  .max(MAX_NOTE_LENGTH, "A note can be at most 2,000 characters.");

export type SaveNoteResult = { ok: true } | { ok: false; error: string };

/**
 * Bookmarks and Notes belong to Students taking the Course: access through
 * their own Enrollment, not through being its Instructor or a Platform Admin.
 */
export function canBookmarkAndNote(
  access: Pick<Access, "enrolled" | "pppBlocked">
) {
  return access.enrolled && !access.pppBlocked;
}

export function isBookmarked(db: Db, studentId: number, lessonId: number) {
  return !!db
    .select({ id: bookmarks.id })
    .from(bookmarks)
    .where(and(eq(bookmarks.userId, studentId), eq(bookmarks.lessonId, lessonId)))
    .get();
}

/** Adds the Bookmark, or removes it if there is one. Returns the new state. */
export function toggleBookmark(
  db: Db,
  studentId: number,
  lessonId: number,
  now: Date
): boolean {
  const removed = db
    .delete(bookmarks)
    .where(and(eq(bookmarks.userId, studentId), eq(bookmarks.lessonId, lessonId)))
    .returning({ id: bookmarks.id })
    .all();
  if (removed.length > 0) return false;

  db.insert(bookmarks)
    .values({ userId: studentId, lessonId, createdAt: now.toISOString() })
    .onConflictDoNothing({ target: [bookmarks.userId, bookmarks.lessonId] })
    .run();
  return true;
}

export function getNote(db: Db, studentId: number, lessonId: number) {
  return db
    .select({ body: notes.body, updatedAt: notes.updatedAt })
    .from(notes)
    .where(and(eq(notes.userId, studentId), eq(notes.lessonId, lessonId)))
    .get();
}

/**
 * Creates the Student's Note on a Lesson, or replaces its body. Either way
 * `updatedAt`, the "last edited" time, becomes `now`; `createdAt` never moves.
 * Saving an empty body deletes the Note.
 */
export function saveNote(
  db: Db,
  studentId: number,
  lessonId: number,
  body: string,
  now: Date
): SaveNoteResult {
  const parsed = noteBodySchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0].message };
  }

  if (parsed.data.length === 0) {
    db.delete(notes)
      .where(and(eq(notes.userId, studentId), eq(notes.lessonId, lessonId)))
      .run();
    return { ok: true };
  }

  const at = now.toISOString();
  db.insert(notes)
    .values({
      userId: studentId,
      lessonId,
      body: parsed.data,
      createdAt: at,
      updatedAt: at,
    })
    .onConflictDoUpdate({
      target: [notes.userId, notes.lessonId],
      set: { body: parsed.data, updatedAt: at },
    })
    .run();
  return { ok: true };
}

// Where a saved row points: its Lesson, and the Course it belongs to.
const lessonPlace = {
  lessonId: lessons.id,
  lessonTitle: lessons.title,
  moduleTitle: modules.title,
  courseId: courses.id,
  courseTitle: courses.title,
  courseSlug: courses.slug,
};

/** The Student's Bookmarks, newest first, for the Saved page. */
export function listBookmarks(db: Db, studentId: number) {
  return db
    .select({ ...lessonPlace, id: bookmarks.id, createdAt: bookmarks.createdAt })
    .from(bookmarks)
    .innerJoin(lessons, eq(bookmarks.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .innerJoin(courses, eq(modules.courseId, courses.id))
    .where(eq(bookmarks.userId, studentId))
    .orderBy(desc(bookmarks.createdAt), desc(bookmarks.id))
    .all();
}

/** The Student's Notes, last edited first, for the Saved page. */
export function listNotes(db: Db, studentId: number) {
  return db
    .select({
      ...lessonPlace,
      id: notes.id,
      body: notes.body,
      updatedAt: notes.updatedAt,
    })
    .from(notes)
    .innerJoin(lessons, eq(notes.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .innerJoin(courses, eq(modules.courseId, courses.id))
    .where(eq(notes.userId, studentId))
    .orderBy(desc(notes.updatedAt), desc(notes.id))
    .all();
}
