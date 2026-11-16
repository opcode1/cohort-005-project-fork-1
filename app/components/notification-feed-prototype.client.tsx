// PROTOTYPE (wayfinder: "Prototype the Notification Feed UI"). Throwaway, lives on
// branch prototype/notification-feed only.
//
// Plan: three structurally different Notification Feed placements mounted in the
// app layout, switchable via ?variant=A|B|C and the floating bottom bar.
//   A: stock SuprSend <Inbox> popover on a top-right bell (zero custom UI)
//   B: headless hooks, bell opens a right-hand slide-over drawer (Unread / Earlier)
//   C: headless hooks, "Notifications" entry in the sidebar opens a full-height page
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import {
  Inbox,
  SuprSendProvider,
  SuprSendFeedProvider,
  useFeedClient,
  useFeedData,
  useSuprSendClient,
  type IRemoteNotification,
} from "@suprsend/react";
import { Bell, BellRing, ChevronLeft, ChevronRight, X } from "lucide-react";

type Props = {
  publicApiKey: string;
  vapidKey: string | null;
  distinctId: string;
  userName: string;
  role: string;
};

const VARIANTS = {
  A: "Stock Inbox popover",
  B: "Headless slide-over drawer",
  C: "Sidebar entry + full page",
} as const;
type VariantKey = keyof typeof VARIANTS;

export default function NotificationFeedPrototype(props: Props) {
  const [params] = useSearchParams();
  const raw = params.get("variant") ?? "A";
  const variant: VariantKey = raw in VARIANTS ? (raw as VariantKey) : "A";

  return (
    <SuprSendProvider
      key={props.distinctId}
      publicApiKey={props.publicApiKey}
      distinctId={props.distinctId}
      vapidKey={props.vapidKey ?? undefined}
      swFileName="serviceworker.js"
    >
      {variant === "A" && <VariantA />}
      {variant !== "A" && (
        <SuprSendFeedProvider>
          {variant === "B" ? <VariantB /> : <VariantC />}
        </SuprSendFeedProvider>
      )}
      <PrototypeBar variant={variant} {...props} />
    </SuprSendProvider>
  );
}

// ---------- A: stock Inbox ----------
function VariantA() {
  return (
    <div className="fixed right-4 top-3 z-40 rounded-full bg-background p-1 shadow">
      <Inbox
        pageSize={20}
        notificationClickHandler={(n) => openNotification(n)}
      />
    </div>
  );
}

// ---------- shared headless bits (B and C) ----------
function openNotification(n: IRemoteNotification) {
  if (n.message.url) window.location.assign(n.message.url);
}

function useFeedState() {
  const feed = useFeedClient();
  const data = useFeedData();
  const notifications = data?.notifications ?? [];
  const unread = notifications.filter((n) => !n.read_on).length;
  return { feed, notifications, unread, loading: data?.isFirstFetch ?? true };
}

function NotificationRow({
  n,
  onOpen,
}: {
  n: IRemoteNotification;
  onOpen: (n: IRemoteNotification) => void;
}) {
  return (
    <button
      onClick={() => onOpen(n)}
      className="flex w-full gap-3 border-b px-4 py-3 text-left hover:bg-muted"
    >
      <span
        className={`mt-1.5 size-2 shrink-0 rounded-full ${n.read_on ? "bg-transparent" : "bg-primary"}`}
      />
      <span className="min-w-0 flex-1">
        {n.message.header && (
          <span className="block text-sm font-medium">{n.message.header}</span>
        )}
        <span className="block text-sm text-muted-foreground">
          {n.message.text}
        </span>
        <span className="mt-1 block text-xs text-muted-foreground">
          {new Date(n.created_on).toLocaleString()}
        </span>
      </span>
    </button>
  );
}

function EmptyFeed() {
  return (
    <p className="p-8 text-center text-sm text-muted-foreground">
      You're all caught up.
    </p>
  );
}

function UnreadBadge({ count }: { count: number }) {
  if (!count) return null;
  return (
    <span className="rounded-full bg-red-600 px-1.5 text-xs font-semibold text-white">
      {count > 9 ? "9+" : count}
    </span>
  );
}

// ---------- B: slide-over drawer ----------
function VariantB() {
  const { feed, notifications, unread } = useFeedState();
  const [open, setOpen] = useState(false);
  const fresh = notifications.filter((n) => !n.read_on);
  const earlier = notifications.filter((n) => n.read_on);
  const onOpen = (n: IRemoteNotification) => {
    feed?.markAsRead(n.n_id);
    openNotification(n);
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="fixed right-4 top-3 z-40 flex items-center gap-1 rounded-full bg-background p-2 shadow"
        aria-label="Notifications"
      >
        <Bell className="size-5" />
        <UnreadBadge count={unread} />
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={() => setOpen(false)}>
          <aside
            className="flex h-full w-full max-w-md flex-col bg-background shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex items-center justify-between border-b px-4 py-3">
              <h2 className="font-semibold">Notifications</h2>
              <div className="flex items-center gap-3">
                <button className="text-sm text-primary" onClick={() => feed?.markAllAsRead()}>
                  Mark all read
                </button>
                <button onClick={() => setOpen(false)} aria-label="Close">
                  <X className="size-5" />
                </button>
              </div>
            </header>
            <div className="flex-1 overflow-y-auto">
              {notifications.length === 0 && <EmptyFeed />}
              {fresh.length > 0 && (
                <h3 className="bg-muted px-4 py-1 text-xs font-semibold uppercase">Unread</h3>
              )}
              {fresh.map((n) => <NotificationRow key={n.n_id} n={n} onOpen={onOpen} />)}
              {earlier.length > 0 && (
                <h3 className="bg-muted px-4 py-1 text-xs font-semibold uppercase">Earlier</h3>
              )}
              {earlier.map((n) => <NotificationRow key={n.n_id} n={n} onOpen={onOpen} />)}
            </div>
          </aside>
        </div>
      )}
    </>
  );
}

// ---------- C: sidebar entry + full page ----------
function VariantC() {
  const { feed, notifications, unread } = useFeedState();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const shown = filter === "unread" ? notifications.filter((n) => !n.read_on) : notifications;
  const onOpen = (n: IRemoteNotification) => {
    feed?.markAsRead(n.n_id);
    openNotification(n);
  };

  return (
    <>
      {/* Sits over the bottom of the 14rem sidebar, standing in for a real nav item. */}
      <button
        onClick={() => setOpen((o) => !o)}
        className="fixed bottom-20 left-3 z-40 flex w-50 items-center gap-2 rounded-md bg-sidebar-accent px-3 py-2 text-sm font-medium text-sidebar-foreground"
      >
        <BellRing className="size-4" />
        <span className="flex-1 text-left">Notifications</span>
        <UnreadBadge count={unread} />
      </button>
      {open && (
        <section className="fixed inset-y-0 left-56 right-0 z-30 overflow-y-auto bg-background">
          <div className="mx-auto max-w-3xl p-8">
            <div className="mb-6 flex items-center justify-between">
              <h1 className="text-2xl font-bold">Notifications</h1>
              <div className="flex items-center gap-2 text-sm">
                {(["all", "unread"] as const).map((f) => (
                  <button
                    key={f}
                    onClick={() => setFilter(f)}
                    className={`rounded-full px-3 py-1 ${filter === f ? "bg-primary text-primary-foreground" : "bg-muted"}`}
                  >
                    {f === "all" ? "All" : `Unread (${unread})`}
                  </button>
                ))}
                <button className="ml-2 text-primary" onClick={() => feed?.markAllAsRead()}>
                  Mark all read
                </button>
                <button onClick={() => setOpen(false)} aria-label="Close">
                  <X className="size-5" />
                </button>
              </div>
            </div>
            <div className="rounded-lg border">
              {shown.length === 0 ? <EmptyFeed /> : shown.map((n) => <NotificationRow key={n.n_id} n={n} onOpen={onOpen} />)}
            </div>
          </div>
        </section>
      )}
    </>
  );
}

// ---------- floating bar: variant switcher + push opt-in + state ----------
function PrototypeBar({ variant, vapidKey, distinctId, role }: { variant: VariantKey } & Props) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const client = useSuprSendClient();
  const [push, setPush] = useState<string>("checking");
  const keys = Object.keys(VARIANTS) as VariantKey[];

  const go = (delta: number) => {
    const next = keys[(keys.indexOf(variant) + delta + keys.length) % keys.length];
    const p = new URLSearchParams(params);
    p.set("variant", next);
    navigate({ search: p.toString() }, { replace: true, preventScrollReset: true });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, [contenteditable]")) return;
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    if (!("Notification" in window)) return setPush("unsupported");
    client.webpush.pushSubscribed().then((s) => setPush(s ? "subscribed" : Notification.permission));
  }, [client]);

  const enablePush = async () => {
    const res = await client.webpush.registerPush();
    console.log("[notifications-prototype] registerPush", res);
    setPush(res.status === "success" ? "subscribed" : `error: ${res.error?.message ?? res.status}`);
  };

  return (
    <div className="fixed bottom-4 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-3 rounded-full bg-zinc-900 px-4 py-2 text-xs text-white shadow-lg">
      <button onClick={() => go(-1)} aria-label="Previous variant"><ChevronLeft className="size-4" /></button>
      <span className="font-semibold">{variant} ({VARIANTS[variant]})</span>
      <button onClick={() => go(1)} aria-label="Next variant"><ChevronRight className="size-4" /></button>
      <span className="text-zinc-400">|</span>
      <span className="text-zinc-300">{distinctId} · {role}</span>
      <span className="text-zinc-400">|</span>
      {push === "subscribed" ? (
        <span className="text-green-400">push on</span>
      ) : (
        <button
          disabled={!vapidKey}
          onClick={enablePush}
          className="rounded-full bg-white px-2 py-0.5 text-zinc-900 disabled:opacity-40"
          title={vapidKey ? "" : "Set SUPRSEND_VAPID_KEY in .env"}
        >
          Enable push ({push})
        </button>
      )}
    </div>
  );
}
