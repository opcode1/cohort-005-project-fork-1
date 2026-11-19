import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { TeamMemberRole } from "~/db/schema";
import { buyTeamLicence, makeIndividualPurchase } from "./purchases.server";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date("2026-10-06T12:00:00.000Z");

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
});

function enrollmentsOf(userId: number) {
  return db
    .select()
    .from(schema.enrollments)
    .where(
      and(
        eq(schema.enrollments.userId, userId),
        eq(schema.enrollments.courseId, base.course.id)
      )
    )
    .all();
}

function purchasesOf(userId: number) {
  return db
    .select()
    .from(schema.purchases)
    .where(eq(schema.purchases.userId, userId))
    .all();
}

function seatsOf(purchaseId: number) {
  return db
    .select()
    .from(schema.coupons)
    .where(eq(schema.coupons.purchaseId, purchaseId))
    .all();
}

function teamAdminships(userId: number) {
  return db
    .select()
    .from(schema.teamMembers)
    .where(
      and(
        eq(schema.teamMembers.userId, userId),
        eq(schema.teamMembers.role, TeamMemberRole.Admin)
      )
    )
    .all();
}

describe("makeIndividualPurchase", () => {
  it("records the Purchase and enrolls the buyer", () => {
    const result = makeIndividualPurchase(
      db,
      base.user.id,
      base.course.id,
      4900,
      "IN",
      NOW
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(purchasesOf(base.user.id)).toEqual([
      expect.objectContaining({
        id: result.purchaseId,
        courseId: base.course.id,
        amountPaid: 4900,
        country: "IN",
        createdAt: NOW.toISOString(),
      }),
    ]);
    expect(enrollmentsOf(base.user.id)).toHaveLength(1);
  });

  it("refuses a buyer who is already enrolled, recording nothing", () => {
    makeIndividualPurchase(db, base.user.id, base.course.id, 4900, null, NOW);

    const result = makeIndividualPurchase(
      db,
      base.user.id,
      base.course.id,
      4900,
      null,
      NOW
    );

    expect(result).toEqual({
      ok: false,
      status: 409,
      error: "You are already enrolled in this course.",
    });
    expect(purchasesOf(base.user.id)).toHaveLength(1);
    expect(enrollmentsOf(base.user.id)).toHaveLength(1);
  });

  it("refuses a course that doesn't exist", () => {
    expect(
      makeIndividualPurchase(db, base.user.id, 999, 4900, null, NOW)
    ).toEqual({ ok: false, status: 404, error: "Course not found." });
    expect(purchasesOf(base.user.id)).toEqual([]);
  });
});

describe("buyTeamLicence", () => {
  it("records the Purchase with one Seat per place, without enrolling the buyer", () => {
    const result = buyTeamLicence(
      db,
      base.user.id,
      base.course.id,
      3 * 4900,
      "IN",
      3,
      NOW
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(purchasesOf(base.user.id)).toEqual([
      expect.objectContaining({
        id: result.purchaseId,
        amountPaid: 3 * 4900,
        country: "IN",
      }),
    ]);
    const seats = seatsOf(result.purchaseId);
    expect(seats).toHaveLength(3);
    expect(new Set(seats.map((seat) => seat.code)).size).toBe(3);
    expect(seats.every((seat) => seat.redeemedByUserId === null)).toBe(true);
    expect(enrollmentsOf(base.user.id)).toEqual([]);
  });

  it("makes the buyer a Team Admin once, reusing their team for later Team Licences", () => {
    const first = buyTeamLicence(
      db,
      base.user.id,
      base.course.id,
      4900,
      null,
      1,
      NOW
    );
    const second = buyTeamLicence(
      db,
      base.user.id,
      base.course.id,
      9800,
      null,
      2,
      NOW
    );

    if (!first.ok || !second.ok) throw new Error("expected both to succeed");
    expect(teamAdminships(base.user.id)).toHaveLength(1);
    const [teamId] = teamAdminships(base.user.id).map((m) => m.teamId);
    expect(
      [...seatsOf(first.purchaseId), ...seatsOf(second.purchaseId)].map(
        (seat) => seat.teamId
      )
    ).toEqual([teamId, teamId, teamId]);
  });

  it("refuses a course that doesn't exist", () => {
    expect(buyTeamLicence(db, base.user.id, 999, 4900, null, 1, NOW)).toEqual({
      ok: false,
      status: 404,
      error: "Course not found.",
    });
    expect(purchasesOf(base.user.id)).toEqual([]);
  });
});
