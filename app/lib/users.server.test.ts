import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { OutboxKind, OutboxStatus } from "~/db/schema";
import { questionAsked } from "~/lib/notify.server";
import {
  drainOutbox,
  enqueue,
  type OutboxMessage,
  type OutboxSender,
  type SendResult,
} from "~/lib/outbox.server";
import { updateUserDetails } from "./users.server";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date("2026-10-06T12:00:00.000Z");

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function getUser(id: number) {
  return db.select().from(schema.users).where(eq(schema.users.id, id)).get();
}

function outboxRows() {
  return db
    .select({
      kind: schema.outbox.kind,
      idempotencyKey: schema.outbox.idempotencyKey,
      payload: schema.outbox.payload,
    })
    .from(schema.outbox)
    .all();
}

describe("updateUserDetails", () => {
  it("saves the new name and email", () => {
    const result = updateUserDetails(
      db,
      base.user.id,
      "Tess User",
      "tess@example.com",
      NOW
    );

    expect(result).toEqual({ ok: true });
    expect(getUser(base.user.id)).toMatchObject({
      name: "Tess User",
      email: "tess@example.com",
    });
  });

  it("swaps the email SuprSend holds when the email changes", () => {
    updateUserDetails(db, base.user.id, "Test User", "tess@example.com", NOW);

    expect(outboxRows()).toEqual([
      {
        kind: "suprsend_user_update",
        idempotencyKey: null,
        payload: {
          distinct_id: String(base.user.id),
          removeEmail: "test@example.com",
          addEmail: "tess@example.com",
        },
      },
    ]);
  });

  it("writes no row when the email is unchanged", () => {
    updateUserDetails(db, base.user.id, "Tess User", "test@example.com", NOW);

    expect(outboxRows()).toEqual([]);
  });

  it("refuses an unknown user", () => {
    expect(
      updateUserDetails(db, 999, "Nobody", "nobody@example.com", NOW)
    ).toEqual({ ok: false, status: 404, error: "User not found." });
    expect(outboxRows()).toEqual([]);
  });
});

// A trigger names its recipient's email as it was at commit. One sent after
// the email swap must not put the old address back in SuprSend.
describe("an email change and Notifications already queued", () => {
  const SECOND = 1000;
  const at = (ms: number) => new Date(NOW.getTime() + ms);

  function questionTo(recipient: { id: number; name: string; email: string }) {
    return questionAsked(
      {
        id: 4,
        body: "Why?",
        lessonId: 3,
        lessonTitle: "Lesson 1",
        courseTitle: "Test Course",
        courseSlug: "test-course",
      },
      base.instructor,
      recipient
    );
  }

  function recordingSender(...results: SendResult[]) {
    const sent: OutboxMessage[] = [];
    const sender: OutboxSender = {
      async send(message) {
        sent.push(message);
        return results.shift() ?? { ok: true };
      },
    };
    return { sender, sent };
  }

  function triggerEmails(sent: OutboxMessage[]) {
    return sent.flatMap((message) =>
      message.kind === OutboxKind.SuprsendTrigger
        ? [message.payload.recipient.$email]
        : []
    );
  }

  it("sends a Notification still waiting for a retry to the new address", async () => {
    enqueue(db, [questionTo(base.user)], NOW);
    await drainOutbox(
      db,
      recordingSender({ ok: false, status: 503, error: "Down" }).sender,
      NOW
    );

    updateUserDetails(
      db,
      base.user.id,
      "Test User",
      "tess@example.com",
      at(SECOND)
    );
    const { sender, sent } = recordingSender();
    await drainOutbox(db, sender, at(SECOND));
    await drainOutbox(db, sender, at(31 * SECOND));

    expect(sent.map((message) => message.kind)).toEqual([
      OutboxKind.SuprsendUserUpdate,
      OutboxKind.SuprsendTrigger,
    ]);
    expect(triggerEmails(sent)).toEqual(["tess@example.com"]);
  });

  it("sends a failed Notification an operator re-queues to the new address", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    enqueue(db, [questionTo(base.user)], NOW);
    await drainOutbox(
      db,
      recordingSender({ ok: false, status: 404, error: "No workflow" }).sender,
      NOW
    );

    updateUserDetails(db, base.user.id, "Test User", "tess@example.com", NOW);
    await drainOutbox(db, recordingSender().sender, NOW);
    db.update(schema.outbox)
      .set({ status: OutboxStatus.Pending })
      .where(eq(schema.outbox.status, OutboxStatus.Failed))
      .run();
    const { sender, sent } = recordingSender();
    await drainOutbox(db, sender, at(SECOND));

    expect(triggerEmails(sent)).toEqual(["tess@example.com"]);
  });

  it("leaves other people's Notifications alone", async () => {
    enqueue(db, [questionTo(base.instructor)], NOW);

    updateUserDetails(db, base.user.id, "Test User", "tess@example.com", NOW);
    const { sender, sent } = recordingSender();
    await drainOutbox(db, sender, NOW);

    expect(triggerEmails(sent)).toEqual(["instructor@example.com"]);
  });
});
