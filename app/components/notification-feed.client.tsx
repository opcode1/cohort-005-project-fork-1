import { useCallback, type ReactNode } from "react";
import {
  SuprSendFeedProvider,
  SuprSendProvider,
  useFeedClient,
  useFeedData,
  type IRemoteNotification,
} from "@suprsend/react-core";
import { z } from "zod";
import {
  NotificationBell,
  type FeedItem,
} from "~/components/notification-drawer";
import { FEED_TOKEN_PATH, FEED_USER_HEADER } from "~/lib/notification-feed";

// The only place SuprSend runs in the browser (docs/adr/0013). Client-only:
// the app layout lazy-loads it after hydration, so server rendering never
// touches the SDK.

type NotificationFeedProps = {
  publicApiKey: string;
  distinctId: string;
  userToken: string;
  footer?: ReactNode;
};

const refreshedToken = z.object({ userToken: z.string() });

export default function NotificationFeed({
  publicApiKey,
  distinctId,
  userToken,
  footer,
}: NotificationFeedProps) {
  // Secure mode tokens last an hour; the SDK calls this shortly before
  // expiry and on auth errors. The route answers 401 when the session's user
  // is no longer the one this tab shows, which leaves this feed dead until a
  // reload instead of reading someone else's Notifications.
  const refreshUserToken = useCallback(async () => {
    const response = await fetch(FEED_TOKEN_PATH, {
      headers: { [FEED_USER_HEADER]: distinctId },
    });
    if (!response.ok) {
      throw new Error(`Notification Feed token refresh: ${response.status}`);
    }
    return refreshedToken.parse(await response.json()).userToken;
  }, [distinctId]);

  return (
    // Keyed by user, so logout and the DevUI switch unmount this provider
    // (resetting the SDK) and identify the next user from scratch. The reset
    // detaches this browser's push from the previous user only; identify then
    // attaches it to the next one, so push follows whoever is signed in and
    // no other device is touched (docs/adr/0015).
    <SuprSendProvider
      key={distinctId}
      publicApiKey={publicApiKey}
      distinctId={distinctId}
      userToken={userToken}
      refreshUserToken={refreshUserToken}
    >
      <SuprSendFeedProvider>
        <LiveNotificationBell footer={footer} />
      </SuprSendFeedProvider>
    </SuprSendProvider>
  );
}

function LiveNotificationBell({ footer }: { footer?: ReactNode }) {
  const feed = useFeedClient();
  const data = useFeedData();

  return (
    <NotificationBell
      items={(data?.notifications ?? []).map(toFeedItem)}
      loading={data?.isFirstFetch ?? true}
      onMarkRead={(item) => feed?.markAsRead(item.id)}
      onMarkAllRead={() => feed?.markAllAsRead()}
      footer={footer}
    />
  );
}

function toFeedItem(notification: IRemoteNotification): FeedItem {
  return {
    id: notification.n_id,
    title: notification.message.header ?? null,
    text: notification.message.text,
    url: notification.message.url ?? null,
    createdAt: notification.created_on,
    read: Boolean(notification.read_on),
  };
}
