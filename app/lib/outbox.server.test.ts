import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "~/test/setup";
import * as schema from "~/db/schema";
import { OutboxKind, OutboxStatus } from "~/db/schema";
import {
  cleanUpOutbox,
  drainOutbox,
  enqueue,
  type OutboxMessage,
  type OutboxSender,
  type SendResult,
} from "./outbox.server";

type TestDb = ReturnType<typeof createTestDb>;

const CREATED = new Date("2026-10-06T12:00:00.000Z");

function at(msAfterCreated: number) {
  return new Date(CREATED.getTime() + msAfterCreated);
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function email(to: string): OutboxMessage {
  return {
    kind: OutboxKind.Email,
    payload: { to, subject: "Refund requested — Test Course", body: "Hi" },
  };
}

/** A sender that answers each message with the next scripted result. */
function fakeSender(...results: SendResult[]) {
  const sent: string[] = [];
  const messages: OutboxMessage[] = [];
  const sender: OutboxSender = {
    async send(message) {
      messages.push(message);
      if (message.kind === OutboxKind.Email) sent.push(message.payload.to);
      return results.shift() ?? { ok: true };
    },
  };
  return { sender, sent, messages };
}

let db: TestDb;

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function rows() {
  return db.select().from(schema.outbox).orderBy(schema.outbox.id).all();
}

function onlyRow() {
  const [row] = rows();
  return row;
}

/** The re-queue an operator runs by hand (see outbox.server.ts), at `now`. */
function requeueFailed(now: Date) {
  db.update(schema.outbox)
    .set({
      status: OutboxStatus.Pending,
      nextAttemptAt: now.toISOString(),
      retryWindowStartedAt: now.toISOString(),
    })
    .where(eq(schema.outbox.status, OutboxStatus.Failed))
    .run();
}

describe("draining the outbox", () => {
  it("marks a sent message as sent", async () => {
    enqueue(db, [email("liam@example.com")], CREATED);
    const { sender, sent } = fakeSender({ ok: true });

    await drainOutbox(db, sender, at(SECOND));

    expect(sent).toEqual(["liam@example.com"]);
    expect(onlyRow()).toMatchObject({
      status: OutboxStatus.Sent,
      attempts: 1,
      sentAt: at(SECOND).toISOString(),
    });
  });

  it("hands SuprSend messages to the sender as they were saved, key and all", async () => {
    const trigger: OutboxMessage = {
      kind: OutboxKind.SuprsendTrigger,
      idempotencyKey: "question-asked:comment:4:user:2",
      payload: {
        workflow: "question-asked",
        recipient: { distinct_id: "2", $email: "ina@example.com", name: "Ina" },
        data: { course_title: "Test Course" },
        link: "/courses/test-course/lessons/3#comment-4",
      },
    };
    const userUpdate: OutboxMessage = {
      kind: OutboxKind.SuprsendUserUpdate,
      payload: {
        distinct_id: "7",
        removeEmail: "old@example.com",
        addEmail: "new@example.com",
      },
    };
    enqueue(db, [trigger, userUpdate], CREATED);
    const { sender, messages } = fakeSender();

    await drainOutbox(db, sender, at(SECOND));

    expect(messages).toEqual([trigger, userUpdate]);
    expect(rows().map((row) => row.idempotencyKey)).toEqual([
      "question-asked:comment:4:user:2",
      null,
    ]);
  });

  it("fails a message at once, without sending it, when its saved payload can't be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    db.insert(schema.outbox)
      .values({
        kind: OutboxKind.SuprsendTrigger,
        payload: { workflow: "no-such-workflow" },
        idempotencyKey: "no-such-workflow:comment:1:user:1",
        createdAt: CREATED.toISOString(),
        nextAttemptAt: CREATED.toISOString(),
        retryWindowStartedAt: CREATED.toISOString(),
      })
      .run();
    const { sender, messages } = fakeSender();

    await drainOutbox(db, sender, at(SECOND));

    expect(messages).toEqual([]);
    expect(onlyRow()).toMatchObject({
      status: OutboxStatus.Failed,
      attempts: 1,
      lastError: expect.stringContaining("payload"),
    });
  });

  it.each([400, 404])("fails a message at once on a %i", async (status) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    enqueue(db, [email("liam@example.com")], CREATED);
    const { sender } = fakeSender({ ok: false, status, error: "Rejected" });

    await drainOutbox(db, sender, at(SECOND));

    expect(onlyRow()).toMatchObject({
      status: OutboxStatus.Failed,
      attempts: 1,
      lastError: `${status}: Rejected`,
      sentAt: null,
    });
  });

  it.each([
    { name: "a 429", result: { ok: false, status: 429, error: "Slow down" } },
    { name: "a 503", result: { ok: false, status: 503, error: "Unavailable" } },
    { name: "a network error", result: { ok: false, error: "ECONNRESET" } },
  ] as const)("retries a message 30s after $name", async ({ result }) => {
    enqueue(db, [email("liam@example.com")], CREATED);
    const { sender } = fakeSender(result);

    await drainOutbox(db, sender, at(SECOND));

    expect(onlyRow()).toMatchObject({
      status: OutboxStatus.Pending,
      attempts: 1,
      lastError: expect.stringContaining(result.error),
      nextAttemptAt: at(31 * SECOND).toISOString(),
    });
  });

  it("retries a message whose sender throws", async () => {
    enqueue(db, [email("liam@example.com")], CREATED);
    const sender: OutboxSender = {
      async send() {
        throw new Error("fetch failed");
      },
    };

    await drainOutbox(db, sender, at(SECOND));

    expect(onlyRow()).toMatchObject({
      status: OutboxStatus.Pending,
      lastError: "fetch failed",
      nextAttemptAt: at(31 * SECOND).toISOString(),
    });
  });

  it("gives up on a call after 10 seconds, aborts it and retries the message", async () => {
    vi.useFakeTimers();
    enqueue(db, [email("liam@example.com")], CREATED);
    let aborted = false;
    const sender: OutboxSender = {
      send(_message, signal) {
        signal.addEventListener("abort", () => (aborted = true));
        return new Promise(() => {});
      },
    };

    const draining = drainOutbox(db, sender, at(SECOND));
    await vi.advanceTimersByTimeAsync(10 * SECOND - 1);
    expect(aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await draining;

    expect(aborted).toBe(true);
    expect(onlyRow()).toMatchObject({
      status: OutboxStatus.Pending,
      attempts: 1,
      lastError: "Timed out after 10s",
      nextAttemptAt: at(31 * SECOND).toISOString(),
    });
  });

  it("backs off exponentially from 30s to a 15-minute cap", async () => {
    enqueue(db, [email("liam@example.com")], CREATED);
    const { sender } = fakeSender(
      ...Array.from({ length: 8 }, () => ({
        ok: false as const,
        status: 500,
        error: "Oops",
      }))
    );

    const gaps: number[] = [];
    let now = CREATED;
    for (let attempt = 0; attempt < 8; attempt++) {
      await drainOutbox(db, sender, now);
      const next = new Date(onlyRow().nextAttemptAt);
      gaps.push((next.getTime() - now.getTime()) / SECOND);
      now = next;
    }

    expect(gaps).toEqual([30, 60, 120, 240, 480, 900, 900, 900]);
  });

  it("keeps retrying a message that has been failing for under 6 hours", async () => {
    enqueue(db, [email("liam@example.com")], CREATED);
    const { sender } = fakeSender({ ok: false, status: 503, error: "Down" });

    await drainOutbox(db, sender, at(6 * HOUR - SECOND));

    expect(onlyRow().status).toBe(OutboxStatus.Pending);
  });

  it("gives up on a message still failing 6 hours after it was created, and logs an error", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    enqueue(db, [email("liam@example.com")], CREATED);
    const { sender } = fakeSender({ ok: false, status: 503, error: "Down" });

    await drainOutbox(db, sender, at(6 * HOUR));

    expect(onlyRow()).toMatchObject({
      status: OutboxStatus.Failed,
      lastError: "503: Down",
    });
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("503: Down"));
  });

  it("sends due messages one at a time, oldest first", async () => {
    enqueue(db, [email("second@example.com")], at(2 * SECOND));
    enqueue(db, [email("first@example.com")], at(SECOND));
    enqueue(db, [email("third@example.com")], at(3 * SECOND));
    const sent: string[] = [];
    let inFlight = 0;
    let mostInFlight = 0;
    const sender: OutboxSender = {
      async send(message) {
        inFlight++;
        mostInFlight = Math.max(mostInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (message.kind === OutboxKind.Email) sent.push(message.payload.to);
        inFlight--;
        return { ok: true };
      },
    };

    await drainOutbox(db, sender, at(MINUTE));

    expect(sent).toEqual([
      "first@example.com",
      "second@example.com",
      "third@example.com",
    ]);
    expect(mostInFlight).toBe(1);
  });

  it("sends a failed message again once an operator resets it to pending", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    enqueue(db, [email("liam@example.com")], CREATED);
    await drainOutbox(
      db,
      fakeSender({ ok: false, status: 404, error: "No such workflow" }).sender,
      at(SECOND)
    );
    expect(onlyRow().status).toBe(OutboxStatus.Failed);

    requeueFailed(at(HOUR));
    const { sender, sent } = fakeSender({ ok: true });
    await drainOutbox(db, sender, at(HOUR));

    expect(sent).toEqual(["liam@example.com"]);
    expect(onlyRow().status).toBe(OutboxStatus.Sent);
  });

  it("gives a re-queued message a fresh 6 hours of retries", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    enqueue(db, [email("liam@example.com")], CREATED);
    await drainOutbox(
      db,
      fakeSender({ ok: false, status: 404, error: "No such workflow" }).sender,
      at(SECOND)
    );

    requeueFailed(at(10 * HOUR));
    const { sender } = fakeSender(
      { ok: false, status: 503, error: "Down" },
      { ok: false, status: 503, error: "Down" }
    );
    await drainOutbox(db, sender, at(10 * HOUR));
    expect(onlyRow().status).toBe(OutboxStatus.Pending);

    await drainOutbox(db, sender, at(16 * HOUR));
    expect(onlyRow().status).toBe(OutboxStatus.Failed);
  });

  it("leaves a message alone until it is due", async () => {
    enqueue(db, [email("liam@example.com")], CREATED);
    await drainOutbox(
      db,
      fakeSender({ ok: false, status: 503, error: "Unavailable" }).sender,
      CREATED
    );
    const { sender, sent } = fakeSender({ ok: true });

    await drainOutbox(db, sender, at(29 * SECOND));
    expect(sent).toEqual([]);

    await drainOutbox(db, sender, at(30 * SECOND));
    expect(sent).toEqual(["liam@example.com"]);
  });
});

describe("cleaning up the outbox", () => {
  it("deletes sent messages older than 30 days and keeps failed ones", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    enqueue(
      db,
      [email("old@example.com"), email("failed@example.com")],
      CREATED
    );
    await drainOutbox(
      db,
      fakeSender({ ok: true }, { ok: false, status: 400, error: "Bad" }).sender,
      CREATED
    );
    enqueue(db, [email("recent@example.com")], at(DAY));
    await drainOutbox(db, fakeSender({ ok: true }).sender, at(DAY));

    cleanUpOutbox(db, at(30 * DAY + SECOND));

    expect(rows().map((row) => [row.status, row.attempts])).toEqual([
      [OutboxStatus.Failed, 1],
      [OutboxStatus.Sent, 1],
    ]);
    expect(rows().map((row) => (row.payload as { to: string }).to)).toEqual([
      "failed@example.com",
      "recent@example.com",
    ]);
  });
});
