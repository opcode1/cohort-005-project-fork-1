# Notifications and Confirmations leave through a transactional outbox

No action calls SuprSend or Postmark itself. Instead, the domain function that makes a decision writes `outbox` rows inside the same SQLite transaction. An in-process dispatcher sends them after commit and retries any that fail. That way, a decision and the messages it causes are either both saved or both not. A SuprSend or Postmark outage, or a process restart, delays a message instead of losing it. And an actor never sees an error for a decision that went through, as a Platform Admin does today when `await sendEmail` throws after a refund decision commits. This covers every Notification (ADR 0013), every Confirmation (ADR 0014) and the email-change sync to SuprSend (ADR 0015).

## Considered Options

- **Call inline after commit, catching and logging failures.** Rejected: one failed call loses the message for good, including the mandatory refund-decision email. The SuprSend SDK never retries and sets no timeout.
- **Outbox only, sent on a timer.** Rejected: a Notification would reach the feed and push up to one polling interval late. Instead, `enqueue` registers a hook that wakes the dispatcher as soon as the transaction commits, and the timer only handles retries.
- **A separate worker process or a hosted queue.** Rejected: Cadence is one process on one SQLite file (ADR 0006).

## Consequences

- Each row is one message to one recipient, of one of three kinds: `suprsend_trigger` (a workflow trigger), `email` (a Confirmation, sent through the mailer's transport) or `suprsend_user_update`. The row holds the full payload as it was at commit, so the dispatcher looks nothing up.
- A SuprSend trigger's `idempotency_key` comes from the domain record: `<notification>:<record>:<id>:user:<recipientId>`, e.g. `refund-approved:refund-request:17:user:42`. Postmark has no such key, so after an ambiguous timeout a Confirmation may rarely be sent twice. We accept that.
- Each call times out after 10s. A `400` or `404` fails the row at once. Any other failure retries with exponential backoff (30s up to a 15-minute cap) for at most 6 hours, well inside SuprSend's 24-hour dedupe window. After that the row is marked `failed` and logged at error level.
- Sent rows are deleted after 30 days. Failed rows are kept. There is no admin UI: an operator finds failed rows with SQL and re-queues them, which is safe because of the key.
- Every domain function that causes a message must run in a transaction, so `raiseRefundRequest`, purchases, Seat claims and question replies gain one where they lack it. Routes no longer import the mailer or the notify module.
- The dispatcher starts at server boot behind a `globalThis` guard, so dev HMR can't start two, and it sends one row at a time. Tests never start it. They call `drainOutbox(db, sender)` with a fake sender.
- The `outbox` table is unrelated to the mailer's `.outbox/` directory, its local-dev transport.
