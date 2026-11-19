import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "~/db/schema";
import { users } from "~/db/schema";
import { userEmailChanged } from "~/lib/notify.server";
import { enqueue, readdressUnsentTriggers } from "~/lib/outbox.server";

// ─── Users ───
// A Platform Admin editing someone's account.
//
// Database first, positional parameters (project convention).

export type Db = BetterSQLite3Database<typeof schema>;

export type UpdateUserResult =
  { ok: true } | { ok: false; status: 404; error: string };

/**
 * Saves a user's name and email. When the email actually changes, the same
 * transaction queues the swap of that email in SuprSend and points the
 * user's unsent Notifications at the new address.
 */
export function updateUserDetails(
  db: Db,
  userId: number,
  name: string,
  email: string,
  now: Date
): UpdateUserResult {
  return db.transaction((tx): UpdateUserResult => {
    const user = tx.select().from(users).where(eq(users.id, userId)).get();
    if (!user) {
      return { ok: false, status: 404, error: "User not found." };
    }

    tx.update(users).set({ name, email }).where(eq(users.id, userId)).run();

    if (email !== user.email) {
      readdressUnsentTriggers(tx, user.id, email);
      enqueue(tx, [userEmailChanged(user.id, user.email, email)], now);
    }

    return { ok: true };
  });
}
