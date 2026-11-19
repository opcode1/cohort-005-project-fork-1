import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { RefundStatus, UserRole } from "~/db/schema";
import { buyTeamLicence } from "./purchases.server";
import { claimSeat, SEAT_ON_HOLD, SEAT_REFUNDED } from "./seats.server";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date("2026-10-06T12:00:00.000Z");

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;
let teamAdmin: typeof schema.users.$inferSelect;
let purchaseId: number;
let code: string;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
  teamAdmin = addUser("Tess");

  const result = buyTeamLicence(
    db,
    teamAdmin.id,
    base.course.id,
    9800,
    "IN",
    2,
    NOW
  );
  if (!result.ok) throw new Error(result.error);
  purchaseId = result.purchaseId;
  code = seats()[0].code;
});

function addUser(name: string) {
  return db
    .insert(schema.users)
    .values({
      name,
      email: `${name.toLowerCase()}@example.com`,
      role: UserRole.Student,
    })
    .returning()
    .get();
}

function seats() {
  return db
    .select()
    .from(schema.coupons)
    .where(eq(schema.coupons.purchaseId, purchaseId))
    .orderBy(schema.coupons.id)
    .all();
}

function isEnrolled(userId: number) {
  return !!db
    .select()
    .from(schema.enrollments)
    .where(
      and(
        eq(schema.enrollments.userId, userId),
        eq(schema.enrollments.courseId, base.course.id)
      )
    )
    .get();
}

describe("claimSeat", () => {
  it("claims the Seat and enrolls the claimant", () => {
    const result = claimSeat(db, code, base.user.id, "IN", NOW);

    expect(result).toEqual({
      ok: true,
      enrollmentId: expect.any(Number),
      courseId: base.course.id,
    });
    expect(seats()[0]).toMatchObject({
      redeemedByUserId: base.user.id,
      redeemedAt: NOW.toISOString(),
    });
    expect(isEnrolled(base.user.id)).toBe(true);
  });

  it("refuses a code that matches no Seat", () => {
    expect(claimSeat(db, "nope", base.user.id, "IN", NOW)).toEqual({
      ok: false,
      error: "Coupon not found",
    });
  });

  it("refuses a Seat someone has already claimed", () => {
    claimSeat(db, code, base.user.id, "IN", NOW);
    const other = addUser("Olu");

    expect(claimSeat(db, code, other.id, "IN", NOW)).toEqual({
      ok: false,
      error: "Coupon has already been redeemed",
    });
    expect(isEnrolled(other.id)).toBe(false);
  });

  it("refuses a Seat on hold while its Team Licence has an Open Refund Request", () => {
    db.insert(schema.refunds)
      .values({ purchaseId, status: RefundStatus.Open, reason: "Not needed" })
      .run();

    expect(claimSeat(db, code, base.user.id, "IN", NOW)).toEqual({
      ok: false,
      error: SEAT_ON_HOLD,
    });
    expect(isEnrolled(base.user.id)).toBe(false);
  });

  it("refuses a refunded Seat", () => {
    db.update(schema.coupons)
      .set({ refundedAt: NOW.toISOString() })
      .where(eq(schema.coupons.code, code))
      .run();

    expect(claimSeat(db, code, base.user.id, "IN", NOW)).toEqual({
      ok: false,
      error: SEAT_REFUNDED,
    });
  });

  it("refuses a claimant who is already enrolled, leaving the Seat unclaimed", () => {
    db.insert(schema.enrollments)
      .values({ userId: base.user.id, courseId: base.course.id })
      .run();

    expect(claimSeat(db, code, base.user.id, "IN", NOW)).toEqual({
      ok: false,
      error: "You are already enrolled in this course",
    });
    expect(seats()[0].redeemedByUserId).toBeNull();
  });

  it("refuses a claimant in a different country from the buyer", () => {
    expect(claimSeat(db, code, base.user.id, "US", NOW)).toEqual({
      ok: false,
      error:
        "This coupon can only be redeemed from the same country as the purchaser",
    });
    expect(claimSeat(db, code, base.user.id, null, NOW).ok).toBe(false);
    expect(seats()[0].redeemedByUserId).toBeNull();
  });

  it("lets anyone claim when the buyer's country is unknown", () => {
    const result = buyTeamLicence(
      db,
      teamAdmin.id,
      base.course.id,
      4900,
      null,
      1,
      NOW
    );
    if (!result.ok) throw new Error(result.error);
    const [seat] = db
      .select()
      .from(schema.coupons)
      .where(eq(schema.coupons.purchaseId, result.purchaseId))
      .all();

    expect(claimSeat(db, seat.code, base.user.id, null, NOW).ok).toBe(true);
  });
});
