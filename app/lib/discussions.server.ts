import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "~/db/schema";
import { comments, courses, lessons, modules, users } from "~/db/schema";
import { MAX_COMMENT_LENGTH, MIN_COMMENT_LENGTH } from "~/lib/comments";
import {
  questionAsked,
  replyPosted,
  type LessonComment,
} from "~/lib/notify.server";
import { enqueue, type OutboxMessage } from "~/lib/outbox.server";

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
      lessonTitle: lessons.title,
    })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .innerJoin(courses, eq(modules.courseId, courses.id))
    .where(eq(lessons.id, lessonId))
    .get();
}

type CourseForLesson = NonNullable<ReturnType<typeof getCourseForLesson>>;
type Comment = typeof comments.$inferSelect;

function getComment(tx: Tx, commentId: number) {
  return tx.select().from(comments).where(eq(comments.id, commentId)).get();
}

function getUser(tx: Tx, userId: number) {
  return tx.select().from(users).where(eq(users.id, userId)).get();
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

    let parent: Comment | null = null;
    if (parentId !== null) {
      const found = getComment(tx, parentId);
      if (!found) {
        return { ok: false, status: 404, error: "Parent comment not found" };
      }
      if (found.lessonId !== lessonId) {
        return {
          ok: false,
          status: 400,
          error: "Parent comment belongs to a different lesson",
        };
      }
      if (found.parentId !== null) {
        return {
          ok: false,
          status: 400,
          error: "Replies can only be one level deep",
        };
      }
      parent = found;
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

    enqueue(tx, notificationsFor(tx, comment, parent, course), now);

    return { ok: true, commentId: comment.id };
  });
}

/**
 * A top-level comment by anyone but the course's Instructor is a Discussion
 * Question, and tells the Instructor. A reply to a Discussion Question is a
 * Discussion Reply, and tells the asker. Nobody is told about their own
 * comment.
 */
function notificationsFor(
  tx: Tx,
  comment: Comment,
  parent: Comment | null,
  course: CourseForLesson
): OutboxMessage[] {
  const author = getUser(tx, comment.userId);
  const instructor = getUser(tx, course.instructorId);
  if (!author || !instructor) return [];

  const lessonComment: LessonComment = {
    id: comment.id,
    body: comment.body,
    lessonId: comment.lessonId,
    lessonTitle: course.lessonTitle,
    courseTitle: course.title,
    courseSlug: course.slug,
  };

  if (parent === null) {
    return author.id === instructor.id
      ? []
      : [questionAsked(lessonComment, author, instructor)];
  }

  // A reply under the Instructor's own top-level comment answers no
  // Discussion Question.
  const isDiscussionQuestion = parent.userId !== instructor.id;
  const asker = getUser(tx, parent.userId);
  if (!isDiscussionQuestion || !asker || asker.id === author.id) return [];

  return [replyPosted(lessonComment, parent.id, author, asker)];
}
