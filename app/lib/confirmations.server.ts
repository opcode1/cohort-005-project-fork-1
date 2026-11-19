import { OutboxKind } from "~/db/schema";
import type { OutboxMessage } from "~/lib/outbox.server";
import { formatPrice } from "~/lib/utils";

// ─── Confirmations ───
// Emails that acknowledge something the person just did. They are never
// Notifications: their text lives here, in code, and they go straight to the
// mailer's transport (docs/adr/0014). Domain functions `enqueue` what these
// return inside their transaction (docs/adr/0016).

type Person = { name: string; email: string };
type Course = { title: string };

function email(to: Person, subject: string, lines: string[]): OutboxMessage {
  return {
    kind: OutboxKind.Email,
    payload: { to: to.email, subject, body: lines.join("\n") },
  };
}

/**
 * The Enrollment welcome, for every new Enrollment: from an Individual
 * Purchase (which gets no separate receipt), from a Claimed Seat, and on
 * re-enrollment.
 */
export function enrollmentWelcome(student: Person, course: Course) {
  return email(student, `Welcome to ${course.title}`, [
    `Hi ${student.name},`,
    "",
    `You are enrolled in "${course.title}". You can start learning straight away: it is waiting for you on your Cadence dashboard.`,
    "",
    "— The Cadence team",
  ]);
}

/** Team Licence bought, to the Team Admin who bought it. */
export function teamLicenceBoughtConfirmation(
  teamAdmin: Person,
  course: Course,
  seatCount: number,
  amountPaid: number
) {
  const seats = `${seatCount} ${seatCount === 1 ? "Seat" : "Seats"}`;
  return email(teamAdmin, `Your Team Licence for ${course.title}`, [
    `Hi ${teamAdmin.name},`,
    "",
    `Thank you for buying a Team Licence: ${seats} on "${course.title}", for ${formatPrice(amountPaid)}.`,
    "",
    "Share a link from your team page with each person you want to give a Seat to. Claiming a Seat enrolls them on the course.",
    "",
    "— The Cadence team",
  ]);
}
