import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { UserRole } from "~/db/schema";
import { identity } from "~/lib/identity.server";
import {
  requireAdmin,
  requireContentAccess,
  requireInstructor,
  requireInstructorOrAdmin,
  requireStaff,
} from "./access.server";

type TestDb = ReturnType<typeof createTestDb>;

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
});

function addUser(name: string, role: UserRole) {
  return db
    .insert(schema.users)
    .values({ name, email: `${name.toLowerCase()}@example.com`, role })
    .returning()
    .get();
}

/** A request from a browser signed in as `userId`, or signed out. */
async function requestAs(userId: number | null, headers: Record<string, string> = {}) {
  if (userId === null) return new Request("http://localhost:5173/", { headers });
  const setCookie = await identity.signIn(new Request("http://localhost:5173/"), userId);
  return new Request("http://localhost:5173/", {
    headers: { Cookie: setCookie.split(";")[0], ...headers },
  });
}

const refusedWith = (status: number) => ({ init: { status } });

describe("requireStaff", () => {
  it("lets the course's own Instructor in", async () => {
    const access = await requireStaff(db, await requestAs(base.instructor.id), base.course.id);

    expect(access.userId).toBe(base.instructor.id);
  });

  it("lets a Platform Admin in", async () => {
    const admin = addUser("Ada", UserRole.Admin);

    const access = await requireStaff(db, await requestAs(admin.id), base.course.id);

    expect(access.isAdmin).toBe(true);
  });

  it("asks a signed-out visitor to sign in", async () => {
    await expect(
      requireStaff(db, await requestAs(null), base.course.id)
    ).rejects.toMatchObject(refusedWith(401));
  });

  it("refuses a Student", async () => {
    await expect(
      requireStaff(db, await requestAs(base.user.id), base.course.id)
    ).rejects.toMatchObject(refusedWith(403));
  });

  it("refuses another course's Instructor", async () => {
    const other = addUser("Olive", UserRole.Instructor);

    await expect(
      requireStaff(db, await requestAs(other.id), base.course.id)
    ).rejects.toMatchObject(refusedWith(403));
  });

  it("refuses the course's Instructor once their role is no longer Instructor", async () => {
    db.update(schema.users)
      .set({ role: UserRole.Student })
      .where(eq(schema.users.id, base.instructor.id))
      .run();

    await expect(
      requireStaff(db, await requestAs(base.instructor.id), base.course.id)
    ).rejects.toMatchObject(refusedWith(403));
  });
});

describe("requireAdmin", () => {
  it("lets a Platform Admin in", async () => {
    const admin = addUser("Ada", UserRole.Admin);

    const user = await requireAdmin(db, await requestAs(admin.id));

    expect(user.id).toBe(admin.id);
  });

  it("asks a signed-out visitor to sign in", async () => {
    await expect(requireAdmin(db, await requestAs(null))).rejects.toMatchObject(
      refusedWith(401)
    );
  });

  it("refuses an Instructor", async () => {
    await expect(
      requireAdmin(db, await requestAs(base.instructor.id))
    ).rejects.toMatchObject(refusedWith(403));
  });
});

describe("requireInstructor", () => {
  it("lets an Instructor in", async () => {
    const user = await requireInstructor(db, await requestAs(base.instructor.id));

    expect(user.id).toBe(base.instructor.id);
  });

  it("refuses a Platform Admin, who would become the Instructor of a course they create", async () => {
    const admin = addUser("Ada", UserRole.Admin);

    await expect(
      requireInstructor(db, await requestAs(admin.id))
    ).rejects.toMatchObject(refusedWith(403));
  });

  it("refuses a Student", async () => {
    await expect(
      requireInstructor(db, await requestAs(base.user.id))
    ).rejects.toMatchObject(refusedWith(403));
  });

  it("asks a signed-out visitor to sign in", async () => {
    await expect(
      requireInstructor(db, await requestAs(null))
    ).rejects.toMatchObject(refusedWith(401));
  });
});

describe("requireInstructorOrAdmin", () => {
  it("lets an Instructor and a Platform Admin in", async () => {
    const admin = addUser("Ada", UserRole.Admin);

    expect((await requireInstructorOrAdmin(db, await requestAs(base.instructor.id))).isAdmin).toBe(false);
    expect((await requireInstructorOrAdmin(db, await requestAs(admin.id))).isAdmin).toBe(true);
  });

  it("refuses a Student", async () => {
    await expect(
      requireInstructorOrAdmin(db, await requestAs(base.user.id))
    ).rejects.toMatchObject(refusedWith(403));
  });
});

describe("requireContentAccess", () => {
  function enroll(userId: number, purchaseCountry?: string) {
    db.insert(schema.enrollments).values({ userId, courseId: base.course.id }).run();
    if (purchaseCountry) {
      db.insert(schema.purchases)
        .values({ userId, courseId: base.course.id, amountPaid: 1000, country: purchaseCountry })
        .run();
    }
  }

  function priceWithPpp() {
    db.update(schema.courses)
      .set({ price: 4900, pppEnabled: true })
      .where(eq(schema.courses.id, base.course.id))
      .run();
  }

  it("lets an enrolled Student read the course", async () => {
    enroll(base.user.id);

    const access = await requireContentAccess(db, await requestAs(base.user.id), base.course.id);

    expect(access.canViewContent).toBe(true);
  });

  it("refuses a Student without an Enrollment", async () => {
    await expect(
      requireContentAccess(db, await requestAs(base.user.id), base.course.id)
    ).rejects.toMatchObject(refusedWith(403));
  });

  it("refuses a Student who bought at India's PPP price and is now in the US", async () => {
    priceWithPpp();
    enroll(base.user.id, "IN");

    await expect(
      requireContentAccess(
        db,
        await requestAs(base.user.id, { "CF-IPCountry": "US" }),
        base.course.id
      )
    ).rejects.toMatchObject(refusedWith(403));
  });

  it("lets that Student read the course from India", async () => {
    priceWithPpp();
    enroll(base.user.id, "IN");

    const access = await requireContentAccess(
      db,
      await requestAs(base.user.id, { "CF-IPCountry": "IN" }),
      base.course.id
    );

    expect(access.canViewContent).toBe(true);
  });

  it("lets the course's Instructor and a Platform Admin read it without an Enrollment", async () => {
    const admin = addUser("Ada", UserRole.Admin);

    for (const userId of [base.instructor.id, admin.id]) {
      const access = await requireContentAccess(db, await requestAs(userId), base.course.id);
      expect(access.canViewContent).toBe(true);
    }
  });

  it("asks a signed-out visitor to sign in", async () => {
    await expect(
      requireContentAccess(db, await requestAs(null), base.course.id)
    ).rejects.toMatchObject(refusedWith(401));
  });
});
