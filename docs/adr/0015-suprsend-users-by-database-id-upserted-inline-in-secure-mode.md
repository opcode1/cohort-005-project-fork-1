# Cadence users reach SuprSend by database id, upserted inline, in secure mode

A SuprSend user's `distinct_id` is `String(users.id)`. It can never change, so it can't be the email, which a Platform Admin can edit. Cadence doesn't sync users to SuprSend at sign-up or on a profile change, and there's no backfill. Instead, each trigger names its recipient inline as `{distinct_id, $email, name}`, so SuprSend upserts the user with current data at send time. The browser's `identify` creates a bare user the first time someone signs in, so the Notification Feed and web push work before their first Notification. Secure mode is on for the public key in every workspace, because without it anyone holding the public key could read any feed by guessing an id. The Notification Feed module (`app/lib/notification-feed.server.ts`), not the notify module, mints a 1-hour ES256 token for the session's user, so routes still never import the notify module (ADR 0016). The app layout's loader returns the token together with the `distinct_id`.

## Considered Options

- **Upsert from the server at sign-up, on a settings save and on an admin edit, plus a backfill**: more hooks into code that has nothing to do with Notifications, and a backfill to run. It's still stale whenever a hook is missed. The inline recipient is always current where it matters, at send time.
- **Secure mode only in Production**: Staging would behave differently from production, and the token and refresh path would go untested until it ships.

## Consequences

- The one exception to "no sync" is a Platform Admin changing a user's email. SuprSend may keep the old address alongside the new one, so the notify module removes the old address and adds the new one.
- A token is refreshed through a resource route that mints for whoever the session cookie names. A tab whose user was switched in another tab loses its feed until it reloads.
- Web push belongs to the browser and follows whoever is signed in. The server never clears `$webpush` on logout, because that would remove the user's subscriptions on every device.
- Cadence has no user deletion, so a GDPR deletion request is handled by hand: the operator deletes the SuprSend user with `users.delete(id)` or in the dashboard.
