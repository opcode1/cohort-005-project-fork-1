import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ─── Transactional email ───
// Postmark delivers every email when POSTMARK_SERVER_TOKEN is set. Without a
// token (local dev, tests) each message is written to .outbox/ as a JSON file
// instead, so it can be read without sending anything.
//
// Only the outbox dispatcher calls a transport (docs/adr/0016). Code that
// causes an email enqueues it instead.

export type Email = {
  to: string;
  subject: string;
  body: string;
};

export interface MailTransport {
  send(email: Email, signal?: AbortSignal): Promise<void>;
}

/** The email service answered, and refused the email with this status. */
export class TransportError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

const FROM_ADDRESS = "Cadence <hello@cadence.dev>";

export function postmarkTransport(serverToken: string): MailTransport {
  return {
    async send(email, signal) {
      const response = await fetch("https://api.postmarkapp.com/email", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Postmark-Server-Token": serverToken,
        },
        body: JSON.stringify({
          From: FROM_ADDRESS,
          To: email.to,
          Subject: email.subject,
          TextBody: email.body,
          MessageStream: "outbound",
        }),
        signal,
      });

      if (!response.ok) {
        throw new TransportError(
          `Postmark rejected the email to ${email.to}`,
          response.status
        );
      }
    },
  };
}

/** Writes each email to `directory` (`.outbox/` in local dev) as JSON. */
export function fileTransport(directory: string): MailTransport {
  return {
    async send(email) {
      mkdirSync(directory, { recursive: true });
      const file = join(directory, `${Date.now()}-${email.to}.json`);
      writeFileSync(
        file,
        JSON.stringify({ from: FROM_ADDRESS, ...email }, null, 2)
      );
    },
  };
}

export function defaultTransport(): MailTransport {
  const token = process.env.POSTMARK_SERVER_TOKEN;
  return token ? postmarkTransport(token) : fileTransport(".outbox");
}
