// PROTOTYPE (wayfinder: "Prototype the Notification Feed UI"). Throwaway, lives on
// branch prototype/notification-feed only. Not production code.
import { Suprsend, WorkflowTriggerRequest } from "@suprsend/node-sdk";

let client: InstanceType<typeof Suprsend> | null = null;

function getClient() {
  const key = process.env.SUPRSEND_WORKSPACE_KEY;
  const secret = process.env.SUPRSEND_WORKSPACE_SECRET;
  if (!key || !secret) return null;
  client ??= new Suprsend(key, secret);
  return client;
}

export function prototypeDistinctId(userId: number) {
  return `cadence-user-${userId}`;
}

export function getSuprSendClientConfig() {
  return {
    publicApiKey: process.env.SUPRSEND_PUBLIC_API_KEY ?? null,
    vapidKey: process.env.SUPRSEND_VAPID_KEY ?? null,
  };
}

// "Question asked" from the v1 catalogue: course Instructor, Feed + push.
// Needs a workflow with slug `question-asked` in the SuprSend Staging
// workspace with Inbox and Web Push nodes.
export async function prototypeNotifyQuestionAsked(input: {
  instructorId: number;
  askerName: string;
  courseTitle: string;
  lessonTitle: string;
  url: string;
  commentId: number;
}) {
  const ss = getClient();
  if (!ss) {
    console.warn("[notifications-prototype] SuprSend keys missing, skipped");
    return;
  }
  const req = new WorkflowTriggerRequest(
    {
      workflow: "question-asked",
      recipients: [{ distinct_id: prototypeDistinctId(input.instructorId) }],
      data: {
        asker_name: input.askerName,
        course_title: input.courseTitle,
        lesson_title: input.lessonTitle,
        url: input.url,
      },
    },
    { idempotency_key: `question-asked-${input.commentId}` }
  );
  try {
    const res = await ss.workflows.trigger(req);
    console.log("[notifications-prototype] trigger", JSON.stringify(res));
  } catch (err) {
    console.error("[notifications-prototype] trigger failed", err);
  }
}
