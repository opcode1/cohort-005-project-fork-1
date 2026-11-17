# Notification email goes through SuprSend, Confirmations go straight to Postmark

Cadence sends two kinds of email, and they take different paths to the same Postmark account. A Notification's email channel (in v1, only the buyer's "Refund Request approved" and "Refund Request declined") goes through the notify module to SuprSend, which sends it with Postmark as its email vendor. That way it shares the delivery log, wording and future preferences with the same Notification's feed and push messages. A Confirmation (Refund requested, the Enrollment welcome, Team Licence bought) acknowledges the person's own action, so it is never a Notification. It stays on the mailer (`app/lib/mailer.server.ts`), which calls Postmark directly.

## Considered Options

- **All email on the mailer**: the refund-decision emails would be the one Notification channel that bypasses the notify module from ADR 0013, and each Notification's wording would be split between code and SuprSend.
- **All email through SuprSend**: Confirmations would then count against SuprSend's monthly volume and depend on SuprSend as well as Postmark, for messages that need none of what SuprSend adds.

## Consequences

- The text of a Notification email lives in SuprSend templates, not in code. Confirmation text lives in code.
- In local development, Notification emails no longer land in `.outbox/`; only Confirmations do.
