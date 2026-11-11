import { data, redirect } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/courses.$slug.refund";
import { getCurrentUserId } from "~/lib/session";
import { db } from "~/db";
import {
  courses,
  refundRequests,
  users,
  RefundRequestStatus,
} from "~/db/schema";
import { eq } from "drizzle-orm";
import { parseFormData, parseParams } from "~/lib/validation";
import { formatPrice } from "~/lib/utils";
import { REFUND_WINDOW_DAYS } from "~/lib/refund-eligibility";
import {
  getRefundEligibility,
  type LearnerRefundEligibility,
} from "~/lib/refund-eligibility.server";

const refundParamsSchema = z.object({
  slug: z.string().min(1),
});

const refundRequestSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(10, "Tell us a little more about why you want a refund.")
    .max(1000, "Please keep your reason under 1000 characters."),
});

function getCourseBySlug(slug: string) {
  return db.select().from(courses).where(eq(courses.slug, slug)).get();
}

type Refusal = Extract<LearnerRefundEligibility, { eligible: false }>["reason"];

const REFUSALS: Record<Refusal, { message: string; status: number }> = {
  "not-purchased": { message: "You have not bought this course.", status: 403 },
  "request-pending": {
    message: "You already have a request open on this purchase.",
    status: 409,
  },
  "claimed-team-seat": {
    message: "A claimed team seat cannot be refunded.",
    status: 403,
  },
  "window-closed": {
    message: `The ${REFUND_WINDOW_DAYS}-day window has closed.`,
    status: 403,
  },
  "watched-too-much": {
    message: "You have watched too much of this course to get a refund.",
    status: 403,
  },
  "completed-too-much": {
    message: "You have completed too much of this course to get a refund.",
    status: 403,
  },
};

/**
 * The confirmation the learner gets in their inbox. There is no mail
 * transport wired up yet, so the built message goes to the server log.
 */
function buildRefundRequestEmail(input: {
  learnerName: string;
  learnerEmail: string;
  courseTitle: string;
  amount: number;
}) {
  return {
    to: input.learnerEmail,
    subject: `Refund requested — ${input.courseTitle}`,
    body: [
      `Hi ${input.learnerName},`,
      "",
      `We have your refund request for "${input.courseTitle}".`,
      `If it is approved, your refund will be ${formatPrice(input.amount)}, the full amount you paid.`,
      "",
      "Our team reviews every refund request by hand. You do not need to do anything else — we will email you again when it is done.",
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}

export async function action({ params, request }: Route.ActionArgs) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("You must be logged in to request a refund.", { status: 401 });
  }

  const { slug } = parseParams(params, refundParamsSchema);
  const course = getCourseBySlug(slug);

  if (!course) {
    throw data("Course not found", { status: 404 });
  }

  const learner = db
    .select()
    .from(users)
    .where(eq(users.id, currentUserId))
    .get();

  if (!learner) {
    throw data("User not found", { status: 404 });
  }

  const eligibility = getRefundEligibility(currentUserId, course.id);

  if (!eligibility.eligible) {
    const refusal = REFUSALS[eligibility.reason];
    throw data(refusal.message, { status: refusal.status });
  }

  const formData = await request.formData();
  const parsed = parseFormData(formData, refundRequestSchema);

  if (!parsed.success) {
    return data({ errors: parsed.errors }, { status: 400 });
  }

  db
    .insert(refundRequests)
    .values({
      purchaseId: eligibility.purchaseId,
      status: RefundRequestStatus.Pending,
      reason: parsed.data.reason,
    })
    .returning()
    .get();

  const email = buildRefundRequestEmail({
    learnerName: learner.name,
    learnerEmail: learner.email,
    courseTitle: course.title,
    amount: eligibility.amount,
  });

  console.log(
    `[email] to=${email.to} subject=${email.subject}\n${email.body}`
  );

  return redirect("/settings");
}
