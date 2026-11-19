import { data } from "react-router";
import type { Route } from "./+types/api.notification-token";
import { getCurrentUserId } from "~/lib/session";
import { notificationFeedFor } from "~/lib/notification-feed.server";
import { FEED_USER_HEADER } from "~/lib/notification-feed";

// Refreshes the Notification Feed's user token before it expires. It takes no
// parameters and mints for the user in the session cookie (docs/adr/0015).
// If that user changed in another tab, this tab's feed must stop rather than
// read someone else's Notifications, so a mismatch is a 401.
export async function loader({ request }: Route.LoaderArgs) {
  const userId = await getCurrentUserId(request);
  const tabUser = request.headers.get(FEED_USER_HEADER);
  if (userId === null || tabUser !== String(userId)) {
    throw data("This tab is not showing the signed-in user", { status: 401 });
  }

  const { userToken } = notificationFeedFor(userId);
  if (!userToken) throw data("No SuprSend signing key", { status: 503 });

  return Response.json(
    { userToken },
    { headers: { "Cache-Control": "no-store" } }
  );
}
