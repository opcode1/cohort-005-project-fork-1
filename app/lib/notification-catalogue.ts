// Shared by the notify module (server) and the Notification Feed (browser):
// nothing here may import server code.

// ─── Catalogue ───
// One SuprSend workflow per Notification. The feed is always a channel; push
// is added only when the recipient must act or is waiting for an answer.
//
// Recipe: adding a Notification
//
// 1. Add a catalogue row below: event → recipient role → channels. The feed
//    is always a channel. Add push only when the recipient must act or is
//    waiting for an answer. Never notify the actor.
// 2. Write the outbox rows. Add a builder in notify.server.ts, and call it
//    in the domain function's transaction: one `outbox` row per message
//    per recipient, with a domain-derived idempotency key,
//    `<workflow>:<record>:<id>:user:<recipientId>` (docs/adr/0016). Name the
//    recipient inline as `{distinct_id, $email, name}` (docs/adr/0015).
//    Resolve recipients inside the transaction and filter out the actor.
//    Store links as app paths; the transport makes them absolute.
//    Test it where the domain function is tested: assert the rows written.
// 3. Set up SuprSend. Add the template and workflow, with those channels,
//    under suprsend/ (see its README), then push and **commit** both to
//    Staging and Production. In the template's Inbox variant, add the
//    workflow slug as a tag: that is how
//    the browser tells which feed item came from which catalogue row. A draft
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

export function isWorkflowSlug(tag: string): tag is WorkflowSlug {
  return Object.hasOwn(NOTIFICATIONS, tag);
}

// A feed item doesn't name its workflow; each template's Inbox channel tags
// it with the workflow slug (step 3 of the recipe).
function catalogueTags(tags: readonly string[] | undefined) {
  return (tags ?? []).filter(isWorkflowSlug);
}

/**
 * Whether a feed item says which Notification it is. One that doesn't can
 * never count as push-eligible, so its template is missing its tag.
 */
export function hasCatalogueTag(tags: readonly string[] | undefined) {
  return catalogueTags(tags).length > 0;
}

/**
 * Whether a feed item goes out as a push too, so it may trigger the web push
 * ask.
 */
export function isPushEligible(tags: readonly string[] | undefined) {
  return catalogueTags(tags).some((slug) => NOTIFICATIONS[slug].pushEligible);
}
