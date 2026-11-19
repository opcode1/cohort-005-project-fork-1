import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { updateUserDetails } from "./users.server";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date("2026-10-06T12:00:00.000Z");

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
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
