import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import { toast } from "sonner";
import { z } from "zod";
import type { Route } from "./+types/admin.refund-requests";
import { getCurrentUserId } from "~/lib/session";
import { parseFormData } from "~/lib/validation";
import { UserRole, users, RefundRequestStatus } from "~/db/schema";
import { db } from "~/db";
import { eq } from "drizzle-orm";
import { Card, CardContent, CardHeader } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { AlertTriangle, ReceiptText } from "lucide-react";
import { data, isRouteErrorResponse, Link } from "react-router";
import { cn, formatDuration, formatPrice } from "~/lib/utils";
import {
  approveRefundRequest,
  declineRefundRequest,
  listRefundRequests,
  type ReviewRefusal,
} from "~/lib/refund-review.server";

const reviewActionSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("approve"),
    requestId: z.coerce.number().int(),
  }),
  z.object({
    intent: z.literal("decline"),
    requestId: z.coerce.number().int(),
    note: z
      .string()
      .trim()
      .min(1, "Tell the learner why their request was declined.")
      .max(1000, "Please keep the note under 1000 characters."),
  }),
]);

const REFUSALS: Record<ReviewRefusal, { message: string; status: number }> = {
  "not-admin": { message: "Only admins can review refund requests.", status: 403 },
  "not-found": { message: "That refund request does not exist.", status: 404 },
  "not-pending": {
    message: "That refund request has already been reviewed.",
    status: 409,
  },
  "note-required": {
    message: "Tell the learner why their request was declined.",
    status: 400,
  },
};

async function requireAdmin(request: Request) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("Select a user from the DevUI panel to review refund requests.", {
      status: 401,
    });
  }

  const currentUser = db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, currentUserId))
    .get();

  if (currentUser?.role !== UserRole.Admin) {
    throw data("Only admins can review refund requests.", { status: 403 });
  }

  return currentUserId;
}

export function meta() {
  return [
    { title: "Refund Requests — Cadence" },
    { name: "description", content: "Approve or Decline Refund Requests" },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);

  const tab =
    new URL(request.url).searchParams.get("tab") === "resolved"
      ? "resolved"
      : "pending";

  return {
    tab,
    refundRequests: listRefundRequests(tab),
    pendingCount: tab === "pending" ? null : listRefundRequests("pending").length,
  } as const;
}

export async function action({ request }: Route.ActionArgs) {
  const adminUserId = await requireAdmin(request);

  const formData = await request.formData();
  const parsed = parseFormData(formData, reviewActionSchema);

  if (!parsed.success) {
    return data(
      { error: Object.values(parsed.errors)[0] ?? "Invalid input." },
      { status: 400 }
    );
  }

  const result =
    parsed.data.intent === "approve"
      ? approveRefundRequest(parsed.data.requestId, adminUserId)
      : declineRefundRequest(
          parsed.data.requestId,
          adminUserId,
          parsed.data.note
        );

  if (!result.ok) {
    const refusal = REFUSALS[result.reason];
    return data({ error: refusal.message }, { status: refusal.status });
  }

  // No mail transport is wired up yet, so the message goes to the server log.
  console.log(
    `[email] to=${result.email.to} subject=${result.email.subject}\n${result.email.body}`
  );

  return { success: true, intent: parsed.data.intent };
}

type RefundRequestRow = Awaited<
  ReturnType<typeof loader>
>["refundRequests"][number];

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatWatchTime(seconds: number) {
  return formatDuration(Math.floor(seconds / 60), true, false, false);
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-0.5 text-sm font-medium">{children}</dd>
    </div>
  );
}

function PendingRefundRequestCard({ row }: { row: RefundRequestRow }) {
  const fetcher = useFetcher<typeof action>();
  const [isDeclining, setIsDeclining] = useState(false);
  const [note, setNote] = useState("");
  const isSubmitting = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if ("error" in fetcher.data) {
      toast.error(fetcher.data.error);
    } else if (fetcher.data.intent === "approve") {
      toast.success(`Refund of ${formatPrice(row.amount)} recorded. ${row.learnerName} no longer has access.`);
    } else {
      toast.success(`Refund request declined. ${row.learnerName} has been told why.`);
    }
  }, [fetcher.state, fetcher.data, row.amount, row.learnerName]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <Link
              to={`/courses/${row.courseSlug}`}
              className="font-semibold hover:underline"
            >
              {row.courseTitle}
            </Link>
            <p className="text-sm text-muted-foreground">
              {row.learnerName} · {row.learnerEmail}
            </p>
          </div>
          <span className="text-lg font-semibold">{formatPrice(row.amount)}</span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <blockquote className="border-l-2 border-border pl-3 text-sm italic text-muted-foreground">
          {row.reason}
        </blockquote>

        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Fact label="Asked on">{formatDate(row.requestedAt)}</Fact>
          <Fact label="Window left when asked">
            {row.daysLeftInWindowWhenAsked === 1
              ? "1 day"
              : `${row.daysLeftInWindowWhenAsked} days`}
          </Fact>
          <Fact label="Watched so far">{formatWatchTime(row.secondsWatched)}</Fact>
          <Fact label="Lessons completed">
            {row.completedLessons} of {row.totalLessons}
          </Fact>
        </dl>
        <p className="text-xs text-muted-foreground">
          The request was eligible when the learner asked. Watch time and
          lessons are shown as they are now, to help you decide.
        </p>

        {isDeclining ? (
          <fetcher.Form method="post" className="space-y-2">
            <input type="hidden" name="intent" value="decline" />
            <input type="hidden" name="requestId" value={row.id} />
            <label htmlFor={`note-${row.id}`} className="text-sm font-medium">
              Why are you declining? The learner will see this.
            </label>
            <Textarea
              id={`note-${row.id}`}
              name="note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              maxLength={1000}
              autoFocus
            />
            <div className="flex gap-2">
              <Button
                type="submit"
                variant="destructive"
                size="sm"
                disabled={isSubmitting || !note.trim()}
              >
                {isSubmitting ? "Declining..." : "Decline"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setIsDeclining(false)}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
            </div>
          </fetcher.Form>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="approve" />
              <input type="hidden" name="requestId" value={row.id} />
              <Button type="submit" size="sm" disabled={isSubmitting}>
                {isSubmitting
                  ? "Approving..."
                  : `Approve and record ${formatPrice(row.amount)} Refund`}
              </Button>
            </fetcher.Form>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsDeclining(true)}
              disabled={isSubmitting}
            >
              Decline...
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ResolvedRefundRequestCard({ row }: { row: RefundRequestRow }) {
  const approved = row.status === RefundRequestStatus.Approved;

  return (
    <Card>
      <CardContent className="space-y-3 pt-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <Link
              to={`/courses/${row.courseSlug}`}
              className="font-semibold hover:underline"
            >
              {row.courseTitle}
            </Link>
            <p className="text-sm text-muted-foreground">
              {row.learnerName} · asked {formatDate(row.requestedAt)}
            </p>
          </div>
          <span
            className={cn(
              "rounded-full px-2.5 py-0.5 text-xs font-medium",
              approved
                ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400"
                : "bg-muted text-muted-foreground"
            )}
          >
            {approved ? "Approved" : "Declined"}
          </span>
        </div>
        <blockquote className="border-l-2 border-border pl-3 text-sm italic text-muted-foreground">
          {row.reason}
        </blockquote>
        <p className="text-sm">
          {approved
            ? `Refund of ${formatPrice(row.amountRefunded)} recorded`
            : "Declined"}
          {row.resolvedAt && ` on ${formatDate(row.resolvedAt)}`}
          {row.resolvedByName && ` by ${row.resolvedByName}`}.
        </p>
        {row.declineNote && (
          <p className="rounded-md bg-muted p-3 text-sm">{row.declineNote}</p>
        )}
      </CardContent>
    </Card>
  );
}

export default function AdminRefundRequests({ loaderData }: Route.ComponentProps) {
  const { tab, refundRequests, pendingCount } = loaderData;
  const pendingTotal = tab === "pending" ? refundRequests.length : pendingCount;

  return (
    <div className="mx-auto max-w-4xl p-6 lg:p-8">
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Home
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">Refund Requests</span>
      </nav>

      <div className="mb-6">
        <h1 className="text-3xl font-bold">Refund Requests</h1>
        <p className="mt-1 text-muted-foreground">
          Approve or Decline what learners have asked for. Approving records the
          Refund and ends the learner's access; no money moves until a payment
          provider is connected.
        </p>
      </div>

      <div className="mb-6 flex gap-1 border-b border-border">
        {(
          [
            ["pending", `Pending${pendingTotal ? ` (${pendingTotal})` : ""}`],
            ["resolved", "Resolved"],
          ] as const
        ).map(([value, label]) => (
          <Link
            key={value}
            to={value === "pending" ? "?" : "?tab=resolved"}
            className={cn(
              "-mb-px border-b-2 px-4 py-2 text-sm font-medium",
              tab === value
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {label}
          </Link>
        ))}
      </div>

      {refundRequests.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center">
            <ReceiptText className="mx-auto mb-3 size-8 text-muted-foreground/50" />
            <p className="text-muted-foreground">
              {tab === "pending"
                ? "No refund requests are waiting for review."
                : "No refund requests have been reviewed yet."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {refundRequests.map((row) =>
            tab === "pending" ? (
              <PendingRefundRequestCard key={row.id} row={row} />
            ) : (
              <ResolvedRefundRequestCard key={row.id} row={row} />
            )
          )}
        </div>
      )}
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading refund requests.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 401) {
      title = "Sign in required";
      message = typeof error.data === "string" ? error.data : "Please select a user from the DevUI panel.";
    } else if (error.status === 403) {
      title = "Access denied";
      message = typeof error.data === "string" ? error.data : "Only admins can review refund requests.";
    } else {
      title = `Error ${error.status}`;
      message = typeof error.data === "string" ? error.data : error.statusText;
    }
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <Link to="/">
          <Button>Go Home</Button>
        </Link>
      </div>
    </div>
  );
}
