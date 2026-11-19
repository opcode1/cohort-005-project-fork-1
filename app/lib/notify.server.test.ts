import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { notificationFileTransport } from "./notify.server";

function readOnlyFile(directory: string) {
  const files = readdirSync(directory);
  expect(files).toHaveLength(1);
  return JSON.parse(readFileSync(join(directory, files[0]), "utf8"));
}

describe("the .outbox/notifications/ transport, used without SuprSend keys", () => {
  it("writes the workflow trigger it would have sent, with an absolute link", async () => {
    const directory = mkdtempSync(join(tmpdir(), "notifications-"));

    const result = await notificationFileTransport(
      directory,
      "https://cadence.example"
    ).trigger(
      {
        workflow: "question-asked",
        recipient: { distinct_id: "2", $email: "ina@example.com", name: "Ina" },
        data: { course_title: "Test Course", asker_name: "Sam" },
        link: "/courses/test-course/lessons/3#comment-4",
      },
      "question-asked:comment:4:user:2"
    );

    expect(result).toEqual({ ok: true });
    expect(readOnlyFile(directory)).toEqual({
      workflow: "question-asked",
      recipients: [
        { distinct_id: "2", $email: "ina@example.com", name: "Ina" },
      ],
      data: {
        course_title: "Test Course",
        asker_name: "Sam",
        url: "https://cadence.example/courses/test-course/lessons/3#comment-4",
      },
      idempotency_key: "question-asked:comment:4:user:2",
    });
  });

  it("writes the email swap it would have made", async () => {
    const directory = mkdtempSync(join(tmpdir(), "notifications-"));

    const result = await notificationFileTransport(
      directory,
      "https://cadence.example"
    ).updateUser({
      distinct_id: "7",
      removeEmail: "old@example.com",
      addEmail: "new@example.com",
    });

    expect(result).toEqual({ ok: true });
    expect(readOnlyFile(directory)).toEqual({
      distinct_id: "7",
      remove_email: "old@example.com",
      add_email: "new@example.com",
    });
  });
});
