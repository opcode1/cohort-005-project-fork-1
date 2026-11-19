import { and, asc, eq, lt, lte, ne, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "~/db/schema";
import { outbox, OutboxKind, OutboxStatus } from "~/db/schema";
import {
  defaultTransport,
  TransportError,
  type Email,
  type MailTransport,
} from "~/lib/mailer.server";
import {
  defaultNotifyTransport,
  type NotifyTransport,
  type SuprsendTrigger,
  type SuprsendUserUpdate,
} from "~/lib/notify.server";

// ─── Outbox ───
// Every message Cadence sends leaves through here (docs/adr/0016). A domain
// function writes rows with `enqueue` inside the transaction that makes its
// decision, so the decision and its messages are saved together or not at all.
// The dispatcher sends them after commit and retries any that fail.
//
// Database first, positional parameters (project convention).

export type Db = BetterSQLite3Database<typeof schema>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** One message to one recipient, with everything it needs to be sent. */
export type OutboxMessage =
  | { kind: OutboxKind.Email; payload: Email }
  | {
      kind: OutboxKind.SuprsendTrigger;
      payload: SuprsendTrigger;
      // Comes from the domain record, never a timestamp, so a retry or a
      // re-queue can't send the same Notification twice.
      idempotencyKey: string;
    }
  | { kind: OutboxKind.SuprsendUserUpdate; payload: SuprsendUserUpdate };

/**
 * Saves messages inside the caller's transaction, due at once, and wakes the
 * dispatcher once that transaction has committed.
 */
export function enqueue(tx: Tx | Db, messages: OutboxMessage[], now: Date) {
  if (messages.length === 0) return;

  tx.insert(outbox)
    .values(
      messages.map((message) => ({
        kind: message.kind,
        payload: message.payload,
        idempotencyKey:
          message.kind === OutboxKind.SuprsendTrigger
            ? message.idempotencyKey
            : null,
        createdAt: now.toISOString(),
        nextAttemptAt: now.toISOString(),
        retryWindowStartedAt: now.toISOString(),
      }))
    )
    .run();

  // better-sqlite3 transactions are synchronous, so by the time this runs the
  // caller's transaction has committed (or rolled back, and there is nothing
  // to send).
  setImmediate(wakeDispatcher);
}

/**
 * Points every unsent SuprSend trigger to `userId` at their new email. Call
 * it in the transaction that changes the email: a trigger saved before it
 * still names the old address, and sent after the email swap it would add
 * that address back in SuprSend (docs/adr/0015). Failed rows are rewritten
 * too, since an operator may re-queue them.
 */
export function readdressUnsentTriggers(
  tx: Tx | Db,
  userId: number,
  email: string
) {
  tx.update(outbox)
    .set({
      payload: sql`json_set(${outbox.payload}, '$.recipient."$email"', ${email})`,
    })
    .where(
      and(
        eq(outbox.kind, OutboxKind.SuprsendTrigger),
        ne(outbox.status, OutboxStatus.Sent),
        sql`json_extract(${outbox.payload}, '$.recipient.distinct_id') = ${String(userId)}`
      )
    )
    .run();
}

// ─── Sending ───

export type SendResult =
  | { ok: true }
  // `status` is the HTTP status, when the far end answered at all.
  | { ok: false; status?: number; error: string };

/** Hands one message to its transport. The real one is `defaultSender`. */
export interface OutboxSender {
  send(message: OutboxMessage, signal: AbortSignal): Promise<SendResult>;
}

type OutboxRow = typeof outbox.$inferSelect;

function nextDueRow(db: Db, now: Date): OutboxRow | undefined {
  return db
    .select()
    .from(outbox)
    .where(
      and(
        eq(outbox.status, OutboxStatus.Pending),
        lte(outbox.nextAttemptAt, now.toISOString())
      )
    )
    .orderBy(asc(outbox.createdAt), asc(outbox.id))
    .get();
}

function toMessage(row: OutboxRow): OutboxMessage {
  // The payload went in as the message's own, so it comes back out as one.
  return (
    row.kind === OutboxKind.SuprsendTrigger
      ? {
          kind: row.kind,
          payload: row.payload,
          idempotencyKey: row.idempotencyKey,
        }
      : { kind: row.kind, payload: row.payload }
  ) as OutboxMessage;
}

/**
 * Sends every message that is due at `now`, one at a time, oldest first, and
 * records how each one went.
 */
export async function drainOutbox(db: Db, sender: OutboxSender, now: Date) {
  for (let row = nextDueRow(db, now); row; row = nextDueRow(db, now)) {
    const result = await sendWithTimeout(sender, toMessage(row));
    record(db, row, result, now);
  }
}

const SEND_TIMEOUT_MS = 10 * 1000;

// Neither Postmark's fetch nor the SuprSend SDK sets a timeout of its own.
async function sendWithTimeout(
  sender: OutboxSender,
  message: OutboxMessage
): Promise<SendResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timedOut = new Promise<SendResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ ok: false, error: "Timed out after 10s" });
    }, SEND_TIMEOUT_MS);
  });

  const sent = sender
    .send(message, controller.signal)
    .catch((error: unknown): SendResult => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));

  try {
    return await Promise.race([sent, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

const FIRST_RETRY_MS = 30 * 1000;
const MAX_RETRY_MS = 15 * 60 * 1000;
// Well inside SuprSend's 24-hour idempotency window.
const GIVE_UP_AFTER_MS = 6 * 60 * 60 * 1000;

// The far end has said this message can never succeed as it stands. Anything
// else (network errors, timeouts, 429, 5xx) may pass on a later try.
function isPermanent(result: SendResult & { ok: false }) {
  return result.status === 400 || result.status === 404;
}

function retryDelayMs(attempts: number) {
  return Math.min(FIRST_RETRY_MS * 2 ** (attempts - 1), MAX_RETRY_MS);
}

function record(db: Db, row: OutboxRow, result: SendResult, now: Date) {
  const attempts = row.attempts + 1;

  if (result.ok) {
    db.update(outbox)
      .set({ status: OutboxStatus.Sent, attempts, sentAt: now.toISOString() })
      .where(eq(outbox.id, row.id))
      .run();
    return;
  }

  const lastError =
    result.status === undefined
      ? result.error
      : `${result.status}: ${result.error}`;

  const failingFor =
    now.getTime() - new Date(row.retryWindowStartedAt).getTime();

  if (!isPermanent(result) && failingFor < GIVE_UP_AFTER_MS) {
    const nextAttemptAt = new Date(now.getTime() + retryDelayMs(attempts));
    db.update(outbox)
      .set({ attempts, lastError, nextAttemptAt: nextAttemptAt.toISOString() })
      .where(eq(outbox.id, row.id))
      .run();
    return;
  }

  db.update(outbox)
    .set({ status: OutboxStatus.Failed, attempts, lastError })
    .where(eq(outbox.id, row.id))
    .run();
  console.error(`Outbox message ${row.id} failed: ${lastError}`);
}

// ─── Cleanup ───

const KEEP_SENT_FOR_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Deletes sent messages older than 30 days. Failed messages are kept, so an
 * operator can find them with SQL and re-queue them.
 *
 * Operator steps, with `sqlite3` on the database file once the cause is
 * fixed. Find the failed rows:
 *
 *   SELECT id, kind, idempotency_key, attempts, last_error, created_at
 *   FROM outbox WHERE status = 'failed';
 *
 * Re-queue them, narrowing the WHERE to the rows you mean. Resetting
 * `retry_window_started_at` gives each one a fresh 6 hours of retries; left
 * alone, a re-queued row would fail again on its first retryable error.
 * Re-sending is safe: a SuprSend trigger keeps its idempotency key.
 *
 *   UPDATE outbox
 *   SET status = 'pending',
 *       next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
 *       retry_window_started_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 *   WHERE status = 'failed';
 *
 * The dispatcher picks them up within 30 seconds.
 */
export function cleanUpOutbox(db: Db, now: Date) {
  const cutoff = new Date(now.getTime() - KEEP_SENT_FOR_MS);
  db.delete(outbox)
    .where(
      and(
        eq(outbox.status, OutboxStatus.Sent),
        lt(outbox.sentAt, cutoff.toISOString())
      )
    )
    .run();
}

// ─── The real sender ───

/** Sends each kind of message through its transport. */
export function defaultSender(
  transport: MailTransport = defaultTransport(),
  notify: NotifyTransport = defaultNotifyTransport()
): OutboxSender {
  return {
    async send(message, signal) {
      switch (message.kind) {
        case OutboxKind.SuprsendTrigger:
          return notify.trigger(
            message.payload,
            message.idempotencyKey,
            signal
          );
        case OutboxKind.SuprsendUserUpdate:
          return notify.updateUser(message.payload, signal);
        case OutboxKind.Email:
          try {
            await transport.send(message.payload, signal);
            return { ok: true };
          } catch (error) {
            return {
              ok: false,
              status:
                error instanceof TransportError ? error.status : undefined,
              error: error instanceof Error ? error.message : String(error),
            };
          }
      }
    },
  };
}

// ─── Dispatcher ───

type Dispatcher = { wake: () => void };

const RETRY_EVERY_MS = 30 * 1000;
const CLEAN_UP_EVERY_MS = 24 * 60 * 60 * 1000;

// Kept on globalThis, not in module scope, so a dev HMR reload of this module
// finds the dispatcher already running instead of starting a second one.
const DISPATCHER_KEY = Symbol.for("cadence.outboxDispatcher");

function getRunningDispatcher(): Dispatcher | undefined {
  return (globalThis as Record<symbol, Dispatcher | undefined>)[DISPATCHER_KEY];
}

function wakeDispatcher() {
  getRunningDispatcher()?.wake();
}

/**
 * Starts sending outbox messages in this process: whenever a transaction that
 * enqueued some commits, and every 30 seconds for retries. Runs once per
 * process however often it is called. Called at server boot, never in tests.
 */
export function startOutboxDispatcher(
  db: Db,
  sender: OutboxSender = defaultSender()
) {
  if (getRunningDispatcher()) return;

  let draining = false;
  let wokenWhileDraining = false;

  async function drain() {
    if (draining) {
      wokenWhileDraining = true;
      return;
    }
    draining = true;
    try {
      do {
        wokenWhileDraining = false;
        await drainOutbox(db, sender, new Date());
      } while (wokenWhileDraining);
    } catch (error) {
      console.error("The outbox dispatcher could not drain the outbox", error);
    } finally {
      draining = false;
    }
  }

  function cleanUp() {
    try {
      cleanUpOutbox(db, new Date());
    } catch (error) {
      console.error(
        "The outbox dispatcher could not clean up the outbox",
        error
      );
    }
  }

  (globalThis as Record<symbol, Dispatcher>)[DISPATCHER_KEY] = {
    wake: () => void drain(),
  };

  setInterval(() => void drain(), RETRY_EVERY_MS).unref();
  setInterval(cleanUp, CLEAN_UP_EVERY_MS).unref();
  cleanUp();
  void drain();
}
