import { data } from "react-router";
import { eq, and } from "drizzle-orm";
import type { Queryable } from "~/db/types";
import {
  UserRole,
  users,
  courses,
  enrollments,
  purchases,
} from "~/db/schema";
import { identity } from "~/lib/identity.server";
import { checkPppAccess } from "~/lib/ppp";

function getUserById(db: Queryable, id: number) {
  return db.select().from(users).where(eq(users.id, id)).get();
}

function getCourseById(db: Queryable, id: number) {
  return db.select().from(courses).where(eq(courses.id, id)).get();
}

function findEnrollment(db: Queryable, userId: number, courseId: number) {
  return db
    .select()
    .from(enrollments)
    .where(
      and(eq(enrollments.userId, userId), eq(enrollments.courseId, courseId))
    )
    .get();
}

function isUserEnrolled(db: Queryable, userId: number, courseId: number) {
  return !!findEnrollment(db, userId, courseId);
}

function findPurchase(db: Queryable, userId: number, courseId: number) {
  return db
    .select()
    .from(purchases)
    .where(and(eq(purchases.userId, userId), eq(purchases.courseId, courseId)))
    .get();
}

// ─── Access Resolution ───
// One place that answers "who is this, and what may they do with this course?".
//
// getAccess never throws — the lesson page needs to render a paywall preview for
// signed-out and unenrolled visitors rather than erroring. The require* wrappers
// are built on it for the routes that should just reject.
//
// Uses positional parameters, database first (project convention).

export type Access = {
  userId: number | null;
  user: ReturnType<typeof getUserById>;
  isAdmin: boolean;
  /** An Instructor, by role, who owns this specific course. */
  isOwningInstructor: boolean;
  /** Owning instructor or admin — the people who speak for the course. */
  isStaff: boolean;
  enrolled: boolean;
  pppBlocked: boolean;
  pppBlockedCountry: string | null;
  pppPurchaseCountry: string | null;
  /**
   * May they read the course's content (lesson bodies, comments)?
   * Staff always can. Students need an enrollment that isn't PPP-blocked.
   */
  canViewContent: boolean;
};

/** Access for someone signed in, as requireStaff and requireContentAccess return it. */
export type SignedInAccess = Access & {
  userId: number;
  user: NonNullable<Access["user"]>;
};

function signedIn(access: Access): SignedInAccess {
  const { userId, user } = access;
  if (!userId || !user) {
    throw data("Select a user from the DevUI panel.", { status: 401 });
  }
  return { ...access, userId, user };
}

const SIGNED_OUT: Access = {
  userId: null,
  user: undefined,
  isAdmin: false,
  isOwningInstructor: false,
  isStaff: false,
  enrolled: false,
  pppBlocked: false,
  pppBlockedCountry: null,
  pppPurchaseCountry: null,
  canViewContent: false,
};

export async function getAccess(
  db: Queryable,
  request: Request,
  courseId: number
): Promise<Access> {
  const userId = await identity.currentUserId(request);
  if (!userId) return SIGNED_OUT;

  const user = getUserById(db, userId);
  if (!user) return SIGNED_OUT;

  const course = getCourseById(db, courseId);
  const isAdmin = user.role === UserRole.Admin;
  // Owning the course is not enough on its own: a role change in admin/users
  // takes their courses away too.
  const isOwningInstructor =
    user.role === UserRole.Instructor && course?.instructorId === userId;
  const isStaff = isAdmin || isOwningInstructor;
  const enrolled = isUserEnrolled(db, userId, courseId);

  // PPP only restricts students who bought at a discount — staff are exempt.
  let ppp = {
    blocked: false,
    blockedCountry: null as string | null,
    purchaseCountry: null as string | null,
  };

  if (enrolled && !isStaff && course) {
    const purchase = findPurchase(db, userId, courseId);
    const currentCountry = await identity.country(request);
    ppp = checkPppAccess(
      course.price,
      course.pppEnabled,
      purchase?.country ?? null,
      currentCountry
    );
  }

  return {
    userId,
    user,
    isAdmin,
    isOwningInstructor,
    isStaff,
    enrolled,
    pppBlocked: ppp.blocked,
    pppBlockedCountry: ppp.blockedCountry,
    pppPurchaseCountry: ppp.purchaseCountry,
    canViewContent: isStaff || (enrolled && !ppp.blocked),
  };
}

/**
 * Throws 401 unless someone is signed in. Returns their user id.
 */
export async function requireUserId(request: Request): Promise<number> {
  const userId = await identity.currentUserId(request);
  if (!userId) {
    throw data("Select a user from the DevUI panel.", { status: 401 });
  }
  return userId;
}

/**
 * Throws 401 when signed out, 403 when the user can't see the course's content.
 * Use in actions — loader guards don't protect actions.
 */
export async function requireContentAccess(
  db: Queryable,
  request: Request,
  courseId: number
): Promise<SignedInAccess> {
  const access = signedIn(await getAccess(db, request, courseId));

  if (!access.canViewContent) {
    throw data("You must be enrolled in this course.", { status: 403 });
  }

  return access;
}

/**
 * Throws unless the user is the course's own instructor, or an admin.
 */
export async function requireStaff(
  db: Queryable,
  request: Request,
  courseId: number
): Promise<SignedInAccess> {
  const access = signedIn(await getAccess(db, request, courseId));

  if (!access.isStaff) {
    throw data("Only this course's instructor can do that.", { status: 403 });
  }

  return access;
}

/**
 * Throws unless the user is an instructor or an admin, without tying them to a
 * particular course — for pages that span all of someone's courses.
 */
export async function requireInstructorOrAdmin(db: Queryable, request: Request) {
  const userId = await requireUserId(request);
  const user = getUserById(db, userId);

  if (
    !user ||
    (user.role !== UserRole.Instructor && user.role !== UserRole.Admin)
  ) {
    throw data("Only instructors can access this page.", { status: 403 });
  }

  return { userId, user, isAdmin: user.role === UserRole.Admin };
}

/**
 * Throws unless the user is a Platform Admin. Returns them.
 */
export async function requireAdmin(db: Queryable, request: Request) {
  const userId = await requireUserId(request);
  const user = getUserById(db, userId);

  if (!user || user.role !== UserRole.Admin) {
    throw data("Only Platform Admins can do that.", { status: 403 });
  }

  return user;
}

/**
 * Throws unless the user is an Instructor. Platform Admins are refused: a
 * course they created would make them its Instructor.
 */
export async function requireInstructor(db: Queryable, request: Request) {
  const userId = await requireUserId(request);
  const user = getUserById(db, userId);

  if (!user || user.role !== UserRole.Instructor) {
    throw data("Only instructors can do that.", { status: 403 });
  }

  return user;
}
