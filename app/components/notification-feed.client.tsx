import { useCallback, useEffect, useRef, useState } from "react";
import {
  SuprSendFeedProvider,
  SuprSendProvider,
  useAuthenticateUser,
  useFeedClient,
  useFeedData,
  useSuprSendClient,
  type IRemoteNotification,
} from "@suprsend/react-core";
import { toast } from "sonner";
import { z } from "zod";
import {
  NotificationBell,
  type FeedItem,
} from "~/components/notification-drawer";
import {
  PUSH_BLOCKED_MESSAGE,
  PushOnThisBrowser,
  type PushStatus,
} from "~/components/push-on-this-browser";
import { isPushEligible } from "~/lib/notification-catalogue";
import { FEED_TOKEN_PATH, FEED_USER_HEADER } from "~/lib/notification-feed";
import { pushPreferences, shouldAskForPush } from "~/lib/push-prompt";

// The only place SuprSend runs in the browser (docs/adr/0013). Client-only:
// the app layout lazy-loads it after hydration, so server rendering never
// touches the SDK.

type NotificationFeedProps = {
  publicApiKey: string;
  /** Without it this browser can't subscribe to web push. */
  vapidKey: string | null;
  distinctId: string;
  userToken: string;
};

// SuprSend's service worker, served from public/ at the site root.
const SERVICE_WORKER_FILE = "serviceworker.js";

const refreshedToken = z.object({ userToken: z.string() });

export default function NotificationFeed({
  publicApiKey,
  vapidKey,
  distinctId,
  userToken,
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
      vapidKey={vapidKey ?? undefined}
      swFileName={SERVICE_WORKER_FILE}
    >
      <SuprSendFeedProvider>
        <LiveNotificationBell />
      </SuprSendFeedProvider>
    </SuprSendProvider>
  );
}

function LiveNotificationBell() {
  const feed = useFeedClient();
  const data = useFeedData();
  const push = usePushOnThisBrowser();
  useAskForPushOnArrival(
    data?.notifications,
    data?.isFirstFetch ?? true,
    push.turnOn
  );

  return (
    <NotificationBell
      items={(data?.notifications ?? []).map(toFeedItem)}
      loading={data?.isFirstFetch ?? true}
      onMarkRead={(item) => feed?.markAsRead(item.id)}
      onMarkAllRead={() => feed?.markAllAsRead()}
      footer={
        <PushOnThisBrowser
          status={push.status}
          ready={push.ready}
          onTurnOn={push.turnOn}
          onTurnOff={push.turnOff}
        />
      }
    />
  );
}

// ─── Web push on this browser ───

function browserSupportsPush() {
  return (
    "Notification" in window &&
    "serviceWorker" in navigator &&
    "PushManager" in window
  );
}

function usePushOnThisBrowser() {
  const client = useSuprSendClient();
  const { authenticatedUser } = useAuthenticateUser();
  const [status, setStatus] = useState<PushStatus>("checking");

  const refresh = useCallback(async () => {
    if (!browserSupportsPush()) return setStatus("unavailable");
    if (Notification.permission === "denied") return setStatus("blocked");
    // pushSubscribed() only asks the browser, and still says true after
    // removePushSubscription(), so Turn off is also remembered here.
    if (
      Notification.permission === "default" ||
      pushPreferences.turnedOffInCadence()
    ) {
      return setStatus("off");
    }
    setStatus((await client.webpush.pushSubscribed()) ? "on" : "off");
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh, authenticatedUser]);

  // Must run straight from a click: browsers show their permission prompt
  // only in response to a user gesture.
  const turnOn = useCallback(async () => {
    const response = await client.webpush.registerPush();
    if (response.status === "success") {
      pushPreferences.setTurnedOffInCadence(false);
      toast.success("Push is on for this browser.");
    } else if (Notification.permission === "denied") {
      toast(PUSH_BLOCKED_MESSAGE);
    } else if (Notification.permission === "granted") {
      console.error("Web push could not be turned on", response.error);
      toast.error("Push couldn't be turned on. Please try again.");
    }
    // Still "default": the prompt was dismissed, so there's nothing to say.
    await refresh();
  }, [client, refresh]);

  const turnOff = useCallback(async () => {
    pushPreferences.setTurnedOffInCadence(true);
    setStatus("off");
    try {
      // Detaches this browser from this user only; other devices keep push.
      await client.webpush.removePushSubscription();
      // That leaves the browser's own subscription in place, and the next
      // identify would attach it again, so end it here too.
      const registration = await navigator.serviceWorker.getRegistration();
      await (await registration?.pushManager.getSubscription())?.unsubscribe();
    } catch (error) {
      console.error("Web push could not be fully turned off", error);
    }
  }, [client]);

  return {
    status,
    ready: authenticatedUser != null,
    turnOn,
    turnOff,
  };
}

// The ask shows at most once per page load, whoever is signed in.
let askedThisPageLoad = false;

/**
 * Cadence never asks on first visit. It asks when a push-eligible
 * Notification lands in the feed, or is unread when the page loads.
 */
function useAskForPushOnArrival(
  notifications: IRemoteNotification[] | undefined,
  loading: boolean,
  turnOn: () => Promise<void>
) {
  // Unset until the first page of the feed loads; every unread item in it
  // counts as an arrival. After that, only items not seen before do.
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (loading || !notifications) return;
    const previouslySeen = seen.current;
    seen.current = new Set([
      ...(previouslySeen ?? []),
      ...notifications.map((notification) => notification.n_id),
    ]);

    const arrivals = notifications.filter(
      (notification) =>
        !notification.read_on && !previouslySeen?.has(notification.n_id)
    );
    const pushEligible = arrivals.find((notification) =>
      isPushEligible(notification.tags)
    );
    const supported = browserSupportsPush();
    const ask = shouldAskForPush({
      permission: supported ? Notification.permission : "default",
      supported,
      turnedOffInCadence: pushPreferences.turnedOffInCadence(),
      snoozedUntil: pushPreferences.snoozedUntil(),
      askedThisPageLoad,
      pushEligible: pushEligible !== undefined,
      now: Date.now(),
    });
    if (!ask || !pushEligible) return;

    askedThisPageLoad = true;
    toast(pushEligible.message.header ?? pushEligible.message.text, {
      description:
        "This could have reached you as a push, even with Cadence closed. Turn on push for this browser?",
      duration: Infinity,
      action: { label: "Turn on push", onClick: () => void turnOn() },
      cancel: {
        label: "Not now",
        onClick: () => pushPreferences.snooze(Date.now()),
      },
    });
  }, [notifications, loading, turnOn]);
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
