import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { setCurrentUserId } from "~/lib/session";

// The route reads the shared `db`; point it at a fresh in-memory database.
const state = vi.hoisted(() => ({
  testDb: undefined as unknown as ReturnType<typeof createTestDb>,
}));
vi.mock("~/db", () => ({
  get db() {
    return state.testDb;
  },
}));

const { action } = await import("./api.video-tracking");

let base: ReturnType<typeof seedBaseData>;
let lessonId: number;

beforeEach(() => {
  state.testDb = createTestDb();
  base = seedBaseData(state.testDb);
  const module = state.testDb
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Module", position: 1 })
    .returning()
    .get();
  lessonId = state.testDb
    .insert(schema.lessons)
    .values({ moduleId: module.id, title: "Lesson", position: 1 })
    .returning()
    .get().id;
});

async function trackAs(userId: number) {
  const cookie = await setCurrentUserId(new Request("http://test"), userId);
  const request = new Request("http://test/api/video-tracking", {
    method: "POST",
    headers: {
      Cookie: cookie,
      "Content-Type": "application/json",
      // Keeps country lookup local instead of calling out to an IP service.
      "CF-IPCountry": "US",
    },
    body: JSON.stringify({ lessonId, eventType: "progress", positionSeconds: 60 }),
  });
  return action({ request, params: {}, context: {} } as never);
}

function watchEventCount() {
  return state.testDb.select().from(schema.videoWatchEvents).all().length;
}

describe("video tracking", () => {
  it("records nothing for a learner without access, such as after a Refund", async () => {
    await expect(trackAs(base.user.id)).rejects.toMatchObject({
      init: { status: 403 },
    });
    expect(watchEventCount()).toBe(0);
  });

  it("records watch progress for an enrolled learner", async () => {
    state.testDb
      .insert(schema.enrollments)
      .values({ userId: base.user.id, courseId: base.course.id })
      .run();

    await trackAs(base.user.id);

    expect(watchEventCount()).toBe(1);
  });
});
