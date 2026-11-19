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

function outboxRows() {
  return db
    .select({
      kind: schema.outbox.kind,
      idempotencyKey: schema.outbox.idempotencyKey,
      payload: schema.outbox.payload,
      status: schema.outbox.status,
    })
    .from(schema.outbox)
    .orderBy(schema.outbox.id)
    .all();
}

function triggers() {
  return outboxRows().filter((row) => row.kind === "suprsend_trigger");
}

function emails() {
  return outboxRows().filter((row) => row.kind === "email");
}

describe("makeIndividualPurchase's Notifications and Confirmations", () => {
  it("tells the course's Instructor about the Individual Purchase", () => {
    const result = makeIndividualPurchase(
      db,
      base.user.id,
      base.course.id,
      4900,
      null,
      NOW
    );
    if (!result.ok) throw new Error(result.error);

    expect(triggers()).toEqual([
      {
        kind: "suprsend_trigger",
        idempotencyKey: `purchase-made:purchase:${result.purchaseId}:user:${base.instructor.id}`,
        status: "pending",
        payload: {
          workflow: "purchase-made",
          recipient: {
            distinct_id: String(base.instructor.id),
            $email: "instructor@example.com",
            name: "Test Instructor",
          },
          data: {
            course_title: "Test Course",
            buyer_name: "Test User",
            amount: "$49.00",
          },
          link: `/instructor/${base.course.id}`,
        },
      },
    ]);
  });

  it("sends the buyer the Enrollment welcome, and no other email", () => {
    makeIndividualPurchase(db, base.user.id, base.course.id, 4900, null, NOW);

    expect(emails()).toEqual([
      {
        kind: "email",
        idempotencyKey: null,
        status: "pending",
        payload: {
          to: "test@example.com",
          subject: "Welcome to Test Course",
          body: expect.stringContaining('You are enrolled in "Test Course"'),
        },
      },
    ]);
  });

  it("tells no one when the Instructor buys their own course, but still welcomes them", () => {
    makeIndividualPurchase(
      db,
      base.instructor.id,
      base.course.id,
      4900,
      null,
      NOW
    );

    expect(triggers()).toEqual([]);
    expect(emails().map((row) => row.payload)).toMatchObject([
      { to: "instructor@example.com", subject: "Welcome to Test Course" },
    ]);
  });

  it("welcomes a Student again when they re-enroll after a refund", () => {
    const first = makeIndividualPurchase(
      db,
      base.user.id,
      base.course.id,
      4900,
      null,
      NOW
    );
    if (!first.ok) throw new Error(first.error);
    // An approved Refund Request ends the Enrollment (docs/adr/0002).
    db.delete(schema.enrollments)
      .where(eq(schema.enrollments.userId, base.user.id))
      .run();

    makeIndividualPurchase(db, base.user.id, base.course.id, 4900, null, NOW);

    expect(emails().map((row) => row.payload)).toMatchObject([
      { to: "test@example.com", subject: "Welcome to Test Course" },
      { to: "test@example.com", subject: "Welcome to Test Course" },
    ]);
  });

  it("writes no rows when the buyer is already enrolled", () => {
    makeIndividualPurchase(db, base.user.id, base.course.id, 4900, null, NOW);
    const before = outboxRows();

    makeIndividualPurchase(db, base.user.id, base.course.id, 4900, null, NOW);

    expect(outboxRows()).toEqual(before);
  });
});

describe("buyTeamLicence's Notifications and Confirmations", () => {
  it("tells the course's Instructor about the Team Licence, with its Seat count", () => {
    const result = buyTeamLicence(
      db,
      base.user.id,
      base.course.id,
      3 * 4900,
      null,
      3,
      NOW
    );
    if (!result.ok) throw new Error(result.error);

    expect(triggers()).toEqual([
      {
        kind: "suprsend_trigger",
        idempotencyKey: `team-licence-bought:purchase:${result.purchaseId}:user:${base.instructor.id}`,
        status: "pending",
        payload: {
          workflow: "team-licence-bought",
          recipient: {
            distinct_id: String(base.instructor.id),
            $email: "instructor@example.com",
            name: "Test Instructor",
          },
          data: {
            course_title: "Test Course",
            buyer_name: "Test User",
            amount: "$147.00",
            seat_count: 3,
          },
          link: `/instructor/${base.course.id}`,
        },
      },
    ]);
  });

  it("confirms the Team Licence to the Team Admin, naming the course and Seats", () => {
    buyTeamLicence(db, base.user.id, base.course.id, 3 * 4900, null, 3, NOW);

    const [confirmation] = emails();
    expect(emails()).toHaveLength(1);
    expect(confirmation.payload).toMatchObject({
      to: "test@example.com",
      subject: "Your Team Licence for Test Course",
    });
    expect((confirmation.payload as { body: string }).body).toContain(
      '3 Seats on "Test Course"'
    );
  });

  it("says Seat, not Seats, for a Team Licence of one", () => {
    buyTeamLicence(db, base.user.id, base.course.id, 4900, null, 1, NOW);

    expect((emails()[0].payload as { body: string }).body).toContain(
      '1 Seat on "Test Course"'
    );
  });

  it("tells no one when the Instructor buys a Team Licence for their own course", () => {
    buyTeamLicence(db, base.instructor.id, base.course.id, 4900, null, 1, NOW);

    expect(triggers()).toEqual([]);
    expect(emails().map((row) => row.payload)).toMatchObject([
      { to: "instructor@example.com" },
    ]);
  });
});
