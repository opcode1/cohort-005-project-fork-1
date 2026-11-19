import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "~/db/schema";
import { comments, courses, lessons, modules } from "~/db/schema";
import { MAX_COMMENT_LENGTH, MIN_COMMENT_LENGTH } from "~/lib/comments";

// ─── Discussions ───
// Posting a comment on a lesson, from the lesson page or the Instructor's
// Questions page. See GLOSSARY.md for Discussion Question and Discussion Reply.
//
// Database first, positional parameters (project convention).

export type Db = BetterSQLite3Database<typeof schema>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type PostCommentResult =
  | { ok: true; commentId: number }
  | { ok: false; status: 400 | 404; error: string };

function getCourseForLesson(tx: Tx, lessonId: number) {
  return tx
    .select({
      id: courses.id,
      title: courses.title,
      slug: courses.slug,
      instructorId: courses.instructorId,
    })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .innerJoin(courses, eq(modules.courseId, courses.id))
    .where(eq(lessons.id, lessonId))
    .get();
}

/**
 * Posts a comment on a lesson: top-level when `parentId` is null, otherwise a
 * reply to the top-level comment `parentId`.
 */
export function postComment(
  db: Db,
  authorId: number,
  lessonId: number,
  parentId: number | null,
  body: string,
  now: Date
): PostCommentResult {
  const trimmed = body.trim();
  if (trimmed.length < MIN_COMMENT_LENGTH) {
    return { ok: false, status: 400, error: "Comment cannot be empty" };
  }
  if (trimmed.length > MAX_COMMENT_LENGTH) {
    return {
      ok: false,
      status: 400,
      error: `Comment must be ${MAX_COMMENT_LENGTH} characters or fewer`,
    };
  }

  return db.transaction((tx): PostCommentResult => {
    const course = getCourseForLesson(tx, lessonId);
    if (!course) {
      return { ok: false, status: 404, error: "Lesson not found" };
    }

    if (parentId !== null) {
      const parent = tx
        .select()
        .from(comments)
        .where(eq(comments.id, parentId))
        .get();
      if (!parent) {
        return { ok: false, status: 404, error: "Parent comment not found" };
      }
      if (parent.lessonId !== lessonId) {
        return {
          ok: false,
          status: 400,
          error: "Parent comment belongs to a different lesson",
        };
      }
      if (parent.parentId !== null) {
        return {
          ok: false,
          status: 400,
          error: "Replies can only be one level deep",
        };
      }
    }

    const comment = tx
      .insert(comments)
      .values({
        userId: authorId,
        lessonId,
        parentId,
        body: trimmed,
        createdAt: now.toISOString(),
      })
      .returning()
      .get();

    return { ok: true, commentId: comment.id };
  });
}
