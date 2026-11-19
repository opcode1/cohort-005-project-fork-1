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
    // The comment id alone repeats after a reseed, so add when it was sent.
    { idempotency_key: `question-asked-${input.commentId}-${Date.now()}` }
  );
  try {
    const res = await ss.workflows.trigger(req);
    console.log("[notifications-prototype] trigger", JSON.stringify(res));
  } catch (err) {
    console.error("[notifications-prototype] trigger failed", err);
  }
}

// ---------- PROTOTYPE (wayfinder: "Prototype the web push permission prompt") ----------
// Secure mode: mint the ES256 user token ADR 0015 describes, so we can check that
// SuprSend's service worker still delivers pushes and records clicks with it on.
import { createPrivateKey, sign, type KeyObject } from "node:crypto";

let signingKey: KeyObject | null | undefined;

function loadSigningKey(): KeyObject | null {
  if (signingKey !== undefined) return signingKey;
  let raw = process.env.SUPRSEND_SIGNING_KEY?.trim().replace(/^['"]|['"]$/g, "");
  signingKey = null;
  if (!raw) return null;
  raw = raw.replace(/\\n/g, "\n");
  try {
    if (!raw.includes("BEGIN")) {
      const decoded = Buffer.from(raw, "base64");
      const text = decoded.toString("utf8");
      signingKey = text.includes("BEGIN")
        ? createPrivateKey(text)
        : createPrivateKey({ key: decoded, format: "der", type: "pkcs8" });
    } else {
      signingKey = createPrivateKey(raw);
    }
  } catch (err) {
    console.error("[notifications-prototype] SUPRSEND_SIGNING_KEY unreadable", err);
  }
  return signingKey;
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");

export function prototypeMintUserToken(distinctId: string): string | null {
  const key = loadSigningKey();
  if (!key) return null;
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "ES256", typ: "JWT" }));
  const body = b64url(
    JSON.stringify({ entity_type: "subscriber", entity_id: distinctId, iat: now, exp: now + 3600 })
  );
  const sig = sign("sha256", Buffer.from(`${head}.${body}`), { key, dsaEncoding: "ieee-p1363" });
  return `${head}.${body}.${b64url(sig)}`;
}
