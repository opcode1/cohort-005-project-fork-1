import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OutboxKind } from "~/db/schema";
import { appBaseUrl } from "~/lib/config.server";
import type { OutboxMessage, SendResult } from "~/lib/outbox.server";
import { formatPrice } from "~/lib/utils";

// ─── Notify ───
// The one server-side place that knows about SuprSend (docs/adr/0013). Domain
// functions call the builders below inside their transaction and `enqueue`
// what they return; the outbox dispatcher hands the rows to the transport at
// the bottom of this file. Routes never import this module.

// ─── Catalogue ───
// One SuprSend workflow per Notification. The feed is always a channel; push
// is added only when the recipient must act or is waiting for an answer.
//
// Recipe: adding a Notification
//
// 1. Add a catalogue row below: event → recipient role → channels. The feed
//    is always a channel. Add push only when the recipient must act or is
//    waiting for an answer. Never notify the actor.
// 2. Write the outbox rows. Add a builder here, and call it in the domain
//    function's transaction: one `outbox` row per message per recipient,
//    with a domain-derived idempotency key,
//    `<workflow>:<record>:<id>:user:<recipientId>` (docs/adr/0016). Name the
//    recipient inline as `{distinct_id, $email, name}` (docs/adr/0015).
//    Resolve recipients inside the transaction and filter out the actor.
//    Store links as app paths; the transport makes them absolute.
//    Test it where the domain function is tested: assert the rows written.
// 3. Set up SuprSend. Create the workflow and its template, with those
//    channels, in Staging and Production, and **commit** both. A draft
//    accepts triggers with a 202 and sends nothing; a missing workflow 404s
//    and fails the row at once, so it must exist before the code ships.
// 4. Push makes it ask-worthy. A Notification with push is push-eligible, so
//    it can trigger the web push ask.

export const NOTIFICATIONS = {
  "refund-raised": {
    notification: "Refund Request raised",
    recipient: "every Platform Admin",
    pushEligible: true,
  },
  // Also email: mandatory, no unsubscribe link (docs/adr/0014).
  "refund-approved": {
    notification: "Refund Request approved",
    recipient: "the buyer (Student or Team Admin)",
    pushEligible: true,
  },
  "refund-approved-instructor": {
    notification: "Refund Request approved",
    recipient: "the course's Instructor",
    pushEligible: false,
  },
  // Also email: mandatory, no unsubscribe link (docs/adr/0014).
  "refund-declined": {
    notification: "Refund Request declined",
    recipient: "the buyer (Student or Team Admin)",
    pushEligible: true,
  },
  "question-asked": {
    notification: "Discussion Question asked",
    recipient: "the course's Instructor",
    pushEligible: true,
  },
  "reply-posted": {
    notification: "Discussion Reply posted",
    recipient: "the person who asked the Discussion Question",
    pushEligible: true,
  },
  "purchase-made": {
    notification: "Individual Purchase made",
    recipient: "the course's Instructor",
    pushEligible: false,
  },
  "team-licence-bought": {
    notification: "Team Licence bought",
    recipient: "the course's Instructor",
    pushEligible: false,
  },
  "seat-claimed": {
    notification: "Seat claimed",
    recipient: "the Team Admin who bought the Team Licence",
    pushEligible: false,
  },
} as const;

export type WorkflowSlug = keyof typeof NOTIFICATIONS;

// ─── Row payloads ───

/**
 * Names the recipient inline, so SuprSend upserts them with current details
 * at send time (docs/adr/0015). `distinct_id` is the database id, unprefixed.
 */
export type Recipient = { distinct_id: string; $email: string; name: string };

/** A workflow trigger (never an event), complete as it was at commit. */
export type SuprsendTrigger = {
  workflow: WorkflowSlug;
  recipient: Recipient;
  data: Record<string, string | number>;
  // An app path. The transport makes it absolute from APP_BASE_URL, since
  // push needs an absolute URL and the request's own URL can't be trusted.
  link: string;
};

/** Swaps the email SuprSend holds for a user after a Platform Admin edit. */
export type SuprsendUserUpdate = {
  distinct_id: string;
  removeEmail: string;
  addEmail: string;
};

type Person = { id: number; name: string; email: string };

function recipient(person: Person): Recipient {
  return {
    distinct_id: String(person.id),
    $email: person.email,
    name: person.name,
  };
}

// `<notification>:<record>:<id>:user:<recipientId>` (docs/adr/0016).
function idempotencyKey(
  workflow: WorkflowSlug,
  record: string,
  recordId: number,
  recipientId: number
) {
  return `${workflow}:${record}:${recordId}:user:${recipientId}`;
}

function trigger(
  workflow: WorkflowSlug,
  record: string,
  recordId: number,
  to: Person,
  data: SuprsendTrigger["data"],
  link: string
): OutboxMessage {
  return {
    kind: OutboxKind.SuprsendTrigger,
    idempotencyKey: idempotencyKey(workflow, record, recordId, to.id),
    payload: { workflow, recipient: recipient(to), data, link },
  };
}

// ─── Refund Requests ───

/** A Refund Request, with what a Notification about it shows. */
export type RefundRequestNotice = {
  id: number;
  courseTitle: string;
  amountPaid: number;
};

/** To each Platform Admin, never the buyer: one row per Platform Admin. */
export function refundRaised(
  refundRequest: RefundRequestNotice,
  buyer: Person,
  platformAdmins: Person[]
): OutboxMessage[] {
  return platformAdmins
    .filter((admin) => admin.id !== buyer.id)
    .map((admin) =>
      trigger(
        "refund-raised",
        "refund-request",
        refundRequest.id,
        admin,
        {
          course_title: refundRequest.courseTitle,
          buyer_name: buyer.name,
          amount: formatPrice(refundRequest.amountPaid),
        },
        "/admin/refunds"
      )
    );
}

/** A decided Refund Request, with what the Notifications about it show. */
export type RefundDecisionNotice = RefundRequestNotice & {
  courseId: number;
  purchaseKind: "individual_purchase" | "team_licence";
  note: string | null;
};

// The buyer sees their Refund Requests on Settings, or a Team Licence's on
// the team page.
function linkForBuyer(decision: RefundDecisionNotice) {
  return decision.purchaseKind === "team_licence" ? "/team" : "/settings";
}

function decisionData(decision: RefundDecisionNotice) {
  return {
    course_title: decision.courseTitle,
    amount: formatPrice(decision.amountPaid),
    note: decision.note ?? "",
  };
}

/** To the buyer, on feed, push and email. */
export function refundApproved(
  decision: RefundDecisionNotice,
  buyer: Person
): OutboxMessage {
  return trigger(
    "refund-approved",
    "refund-request",
    decision.id,
    buyer,
    decisionData(decision),
    linkForBuyer(decision)
  );
}

/** To the course's Instructor, unless they decided it themselves. */
export function refundApprovedToInstructor(
  decision: RefundDecisionNotice,
  buyer: Person,
  instructor: Person,
  actorId: number
): OutboxMessage[] {
  if (instructor.id === actorId) return [];
  return [
    trigger(
      "refund-approved-instructor",
      "refund-request",
      decision.id,
      instructor,
      {
        course_title: decision.courseTitle,
        buyer_name: buyer.name,
        amount: formatPrice(decision.amountPaid),
      },
      `/instructor/${decision.courseId}`
    ),
  ];
}

/** To the buyer, on feed, push and email, with the Platform Admin's note. */
export function refundDeclined(
  decision: RefundDecisionNotice,
  buyer: Person
): OutboxMessage {
  return trigger(
    "refund-declined",
    "refund-request",
    decision.id,
    buyer,
    decisionData(decision),
    linkForBuyer(decision)
  );
}

// ─── Users ───

/**
 * After a Platform Admin changes someone's email: SuprSend may keep the old
 * address beside the new one, so remove it and add the new one
 * (docs/adr/0015). The user edit is naturally repeatable, so it needs no
 * idempotency key.
 */
export function userEmailChanged(
  userId: number,
  oldEmail: string,
  newEmail: string
): OutboxMessage {
  return {
    kind: OutboxKind.SuprsendUserUpdate,
    payload: {
      distinct_id: String(userId),
      removeEmail: oldEmail,
      addEmail: newEmail,
    },
  };
}

// ─── Discussions ───

/** A comment on a lesson, with what a Notification about it shows. */
export type LessonComment = {
  id: number;
  body: string;
  lessonId: number;
  lessonTitle: string;
  courseTitle: string;
  courseSlug: string;
};

const EXCERPT_LENGTH = 140;

function excerpt(body: string) {
  const text = body.replace(/\s+/g, " ").trim();
  return text.length <= EXCERPT_LENGTH
    ? text
    : `${text.slice(0, EXCERPT_LENGTH - 1).trimEnd()}…`;
}

function linkToQuestion(comment: LessonComment, questionId: number) {
  return `/courses/${comment.courseSlug}/lessons/${comment.lessonId}#comment-${questionId}`;
}

export function questionAsked(
  question: LessonComment,
  asker: Person,
  instructor: Person
): OutboxMessage {
  return trigger(
    "question-asked",
    "comment",
    question.id,
    instructor,
    {
      course_title: question.courseTitle,
      lesson_title: question.lessonTitle,
      asker_name: asker.name,
      excerpt: excerpt(question.body),
    },
    linkToQuestion(question, question.id)
  );
}

export function replyPosted(
  reply: LessonComment,
  questionId: number,
  replier: Person,
  asker: Person
): OutboxMessage {
  return trigger(
    "reply-posted",
    "comment",
    reply.id,
    asker,
    {
      course_title: reply.courseTitle,
      lesson_title: reply.lessonTitle,
      replier_name: replier.name,
      excerpt: excerpt(reply.body),
    },
    linkToQuestion(reply, questionId)
  );
}

// ─── Purchases and Seats ───

/** A Purchase, with what a Notification about it shows. */
export type CoursePurchase = {
  id: number;
  amountPaid: number;
  courseId: number;
  courseTitle: string;
};

function linkToInstructorCourse(courseId: number) {
  return `/instructor/${courseId}`;
}

export function purchaseMade(
  purchase: CoursePurchase,
  buyer: Person,
  instructor: Person
): OutboxMessage {
  return trigger(
    "purchase-made",
    "purchase",
    purchase.id,
    instructor,
    {
      course_title: purchase.courseTitle,
      buyer_name: buyer.name,
      amount: formatPrice(purchase.amountPaid),
    },
    linkToInstructorCourse(purchase.courseId)
  );
}

export function teamLicenceBought(
  purchase: CoursePurchase,
  seatCount: number,
  teamAdmin: Person,
  instructor: Person
): OutboxMessage {
  return trigger(
    "team-licence-bought",
    "purchase",
    purchase.id,
    instructor,
    {
      course_title: purchase.courseTitle,
      buyer_name: teamAdmin.name,
      amount: formatPrice(purchase.amountPaid),
      seat_count: seatCount,
    },
    linkToInstructorCourse(purchase.courseId)
  );
}

export function seatClaimed(
  seatId: number,
  courseTitle: string,
  claimant: Person,
  teamAdmin: Person
): OutboxMessage {
  return trigger(
    "seat-claimed",
    "seat",
    seatId,
    teamAdmin,
    { course_title: courseTitle, claimant_name: claimant.name },
    "/team"
  );
}

// ─── Transports ───
// Only the outbox dispatcher calls these (docs/adr/0016).

export interface NotifyTransport {
  trigger(
    trigger: SuprsendTrigger,
    idempotencyKey: string,
    signal?: AbortSignal
  ): Promise<SendResult>;
  updateUser(
    update: SuprsendUserUpdate,
    signal?: AbortSignal
  ): Promise<SendResult>;
}

/** The trigger's data, with the link made absolute for push. */
function dataWithUrl(trigger: SuprsendTrigger, baseUrl: string) {
  return { ...trigger.data, url: new URL(trigger.link, baseUrl).toString() };
}

/**
 * Without SuprSend keys (local dev), writes what would have been sent to
 * `.outbox/notifications/` as JSON, so it can be read without an account.
 */
export function notificationFileTransport(
  directory: string,
  baseUrl: string
): NotifyTransport {
  function write(name: string, contents: unknown) {
    mkdirSync(directory, { recursive: true });
    const file = join(directory, `${Date.now()}-${name}.json`);
    writeFileSync(file, JSON.stringify(contents, null, 2));
  }

  return {
    async trigger(trigger, idempotencyKey) {
      write(idempotencyKey.replaceAll(":", "-"), {
        workflow: trigger.workflow,
        recipients: [trigger.recipient],
        data: dataWithUrl(trigger, baseUrl),
        idempotency_key: idempotencyKey,
      });
      return { ok: true };
    },
    async updateUser(update) {
      write(`user-${update.distinct_id}`, {
        distinct_id: update.distinct_id,
        remove_email: update.removeEmail,
        add_email: update.addEmail,
      });
      return { ok: true };
    },
  };
}

type SuprsendKeys = { workspaceKey: string; workspaceSecret: string };

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Sends through SuprSend's Node SDK. The SDK returns trigger failures instead
 * of throwing, throws for user edits, and sets no timeout; this turns each
 * into a `SendResult`, and the outbox's 10-second race covers the timeout.
 * Checked by hand against Staging, not in tests.
 */
export function suprsendTransport(
  keys: SuprsendKeys,
  baseUrl: string
): NotifyTransport {
  // Loaded on first send, so nothing that only builds rows loads the SDK.
  let client: Promise<SdkClient> | undefined;
  function getClient() {
    client ??= import("@suprsend/node-sdk").then((sdk) => ({
      sdk,
      suprsend: new sdk.Suprsend(keys.workspaceKey, keys.workspaceSecret),
    }));
    return client;
  }

  return {
    async trigger(trigger, idempotencyKey, signal) {
      if (signal?.aborted) return { ok: false, error: "Aborted" };
      try {
        const { sdk, suprsend } = await getClient();
        const request = new sdk.WorkflowTriggerRequest(
          {
            workflow: trigger.workflow,
            recipients: [trigger.recipient],
            data: dataWithUrl(trigger, baseUrl),
          },
          { idempotency_key: idempotencyKey }
        );
        // Typed as a bulk response, but `trigger` resolves with
        // `{ success, status_code, message }` and never throws for HTTP or
        // network errors (a network error comes back as a 500).
        const response: { status_code: number; message?: unknown } =
          await suprsend.workflows.trigger(request);
        if (response.status_code >= 200 && response.status_code < 300) {
          return { ok: true };
        }
        return {
          ok: false,
          status: response.status_code,
          error: String(response.message ?? "SuprSend refused the trigger"),
        };
      } catch (error) {
        // Only a body the SDK itself rejects throws; it can never succeed.
        return { ok: false, status: 400, error: errorMessage(error) };
      }
    },

    async updateUser(update, signal) {
      if (signal?.aborted) return { ok: false, error: "Aborted" };
      try {
        const { suprsend } = await getClient();
        const edit = suprsend.users.get_edit_instance(update.distinct_id);
        edit.remove_email(update.removeEmail);
        edit.add_email(update.addEmail);
        await suprsend.users.edit(edit);
        return { ok: true };
      } catch (error) {
        // SuprsendApiError reads "<status>: <message>" when SuprSend answered.
        const message = errorMessage(error);
        const status = /^(\d{3}):/.exec(message)?.[1];
        return {
          ok: false,
          status: status === undefined ? undefined : Number(status),
          error: message,
        };
      }
    },
  };
}

type SdkModule = typeof import("@suprsend/node-sdk");
type SdkClient = {
  sdk: SdkModule;
  suprsend: InstanceType<SdkModule["Suprsend"]>;
};

/**
 * SuprSend when its workspace keys are set (Staging in dev, Production when
 * deployed), else `.outbox/notifications/`. Production refuses to boot
 * without keys (see config.server.ts), so it never writes files.
 */
export function defaultNotifyTransport(
  env: Record<string, string | undefined> = process.env
): NotifyTransport {
  const baseUrl = appBaseUrl(env);
  const workspaceKey = env.SUPRSEND_WORKSPACE_KEY;
  const workspaceSecret = env.SUPRSEND_WORKSPACE_SECRET;
  return workspaceKey && workspaceSecret
    ? suprsendTransport({ workspaceKey, workspaceSecret }, baseUrl)
    : notificationFileTransport(join(".outbox", "notifications"), baseUrl);
}
