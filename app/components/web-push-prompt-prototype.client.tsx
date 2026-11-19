// PROTOTYPE (wayfinder: "Prototype the web push permission prompt"). Throwaway,
// lives on branch prototype/web-push-prompt only. Not production code.
//
// Plan: the chosen Notification Feed drawer (variant B of the feed prototype) is
// fixed. Three different answers to "when and where do we ask for web push?" are
// switchable via ?variant=A|B|C and the floating bottom bar:
//   A: Ask in context. A soft-ask card at the moment push clearly matters: just
//      after asking a Discussion Question or raising a Refund Request (you're now
//      waiting), or on the page where you act on push Notifications
//      (Instructor: Questions; Platform Admin: Refunds).
//   B: Ask in the feed. Nothing interrupts pages; the offer sits at the top of
//      the Notification Feed drawer.
//   C: Ask when one arrives. When a Notification lands in your feed, a toast
//      says "this could have reached you as a push" and offers to turn it on.
// All variants share the after-refusal behaviour and the one place to turn push
// back on or off: a "Push on this browser" row at the foot of the drawer.
//
// Browser permission is sticky, so the bar can SIMULATE a permission state; in
// simulated modes "Turn on" shows a fake browser prompt instead of the real one.
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import {
  SuprSendProvider,
  SuprSendFeedProvider,
  useFeedClient,
  useFeedData,
  useSuprSendClient,
  type IRemoteNotification,
} from "@suprsend/react";
import { Bell, BellOff, BellRing, ChevronLeft, ChevronRight, X } from "lucide-react";

type Props = {
  publicApiKey: string;
  vapidKey: string | null;
  distinctId: string;
  userToken: string | null;
  userName: string;
  role: string;
};

const VARIANTS = {
  A: "Ask in context",
  B: "Ask in the feed",
  C: "Ask when one arrives",
} as const;
type VariantKey = keyof typeof VARIANTS;

type Sim = "real" | "default" | "denied" | "unsupported";
const SIMS: Sim[] = ["real", "default", "denied", "unsupported"];

const SNOOZE_DAYS = 30;
const LS = {
  sim: "proto-push-sim",
  snooze: "proto-push-snoozed-until",
  simSubscribed: "proto-push-sim-subscribed",
};
const ls = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string | null) => {
    try {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      /* ignore */
    }
  },
};

export default function WebPushPromptPrototype(props: Props) {
  const [params] = useSearchParams();
  const raw = params.get("variant") ?? "A";
  const variant: VariantKey = raw in VARIANTS ? (raw as VariantKey) : "A";

  return (
    <SuprSendProvider
      key={props.distinctId}
      publicApiKey={props.publicApiKey}
      distinctId={props.distinctId}
      userToken={props.userToken ?? undefined}
      refreshUserToken={async () => {
        const res = await fetch("/api/notification-token");
        if (!res.ok) throw new Error(`token refresh ${res.status}`);
        return ((await res.json()) as { token: string }).token;
      }}
      vapidKey={props.vapidKey ?? undefined}
      swFileName="serviceworker.js"
    >
      <SuprSendFeedProvider>
        <Prototype variant={variant} {...props} />
      </SuprSendFeedProvider>
    </SuprSendProvider>
  );
}

// ---------- push state (real or simulated) ----------

type PushStatus =
  | "checking"
  | "unsupported" // e.g. iPhone Safari tab, not a Home Screen web app
  | "ask" // permission "default": we may ask
  | "on" // permission granted and this browser is subscribed
  | "off" // permission granted but turned off in Cadence
  | "blocked"; // permission "denied": only the browser can undo it

function usePush(vapidKey: string | null) {
  const client = useSuprSendClient();
  const [sim, setSimState] = useState<Sim>(() => (ls.get(LS.sim) as Sim) ?? "real");
  const [status, setStatus] = useState<PushStatus>("checking");
  const [fakePrompt, setFakePrompt] = useState<null | ((allow: boolean) => void)>(null);
  const [snoozedUntil, setSnoozedUntil] = useState<number>(() => Number(ls.get(LS.snooze) ?? 0));

  const refresh = async () => {
    if (sim !== "real") {
      if (sim === "unsupported") return setStatus("unsupported");
      if (sim === "denied") return setStatus("blocked");
      const s = ls.get(LS.simSubscribed);
      return setStatus(s === "on" ? "on" : s === "off" ? "off" : "ask");
    }
    if (!("Notification" in window) || !("serviceWorker" in navigator)) {
      return setStatus("unsupported");
    }
    if (Notification.permission === "denied") return setStatus("blocked");
    if (Notification.permission === "default") return setStatus("ask");
    const subscribed = await client.webpush.pushSubscribed();
    setStatus(subscribed ? "on" : "off");
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sim, client]);

  const setSim = (s: Sim) => {
    ls.set(LS.sim, s);
    ls.set(LS.simSubscribed, null);
    setSimState(s);
  };

  /** Must be called from a click: browsers need a user gesture. */
  const turnOn = async (): Promise<PushStatus> => {
    if (sim !== "real") {
      if (status === "off") {
        ls.set(LS.simSubscribed, "on");
        setStatus("on");
        return "on";
      }
      const allowed = await new Promise<boolean>((resolve) =>
        setFakePrompt(() => (allow: boolean) => resolve(allow))
      );
      setFakePrompt(null);
      if (allowed) {
        ls.set(LS.simSubscribed, "on");
        setStatus("on");
        return "on";
      }
      ls.set(LS.sim, "denied");
      setSimState("denied");
      setStatus("blocked");
      return "blocked";
    }
    if (!vapidKey) {
      toast.error("Set SUPRSEND_VAPID_KEY in .env");
      return status;
    }
    const res = await client.webpush.registerPush();
    console.log("[web-push-prompt-prototype] registerPush", res);
    await refresh();
    if (res.status !== "success" && Notification.permission === "granted") {
      toast.error(`registerPush: ${res.error?.message ?? res.status}`);
    }
    return Notification.permission === "denied"
      ? "blocked"
      : res.status === "success"
        ? "on"
        : "ask";
  };

  const turnOff = async () => {
    if (sim !== "real") {
      ls.set(LS.simSubscribed, "off");
      setStatus("off");
      return;
    }
    const res = await client.webpush.removePushSubscription();
    console.log("[web-push-prompt-prototype] removePushSubscription", res);
    await refresh();
  };

  const snooze = () => {
    const until = Date.now() + SNOOZE_DAYS * 864e5;
    ls.set(LS.snooze, String(until));
    setSnoozedUntil(until);
  };
  const resetSnooze = () => {
    ls.set(LS.snooze, null);
    setSnoozedUntil(0);
  };

  const snoozed = snoozedUntil > Date.now();
  // Soft asks only ever appear while the browser would still show its prompt and
  // the person hasn't said "Not now" recently. Blocked, off-by-choice and
  // unsupported browsers are never nagged; the drawer row is their way back.
  const mayAsk = status === "ask" && !snoozed;

  return { sim, setSim, status, turnOn, turnOff, snooze, snoozed, resetSnooze, mayAsk, fakePrompt };
}
type Push = ReturnType<typeof usePush>;

/** Shared outcome toast after any "Turn on" click. */
async function turnOnWithFeedback(push: Push) {
  const result = await push.turnOn();
  if (result === "on") toast.success("Push is on for this browser.");
  if (result === "blocked")
    toast("Push is blocked in this browser. Everything still arrives in Notifications (the bell).");
}

// ---------- the page-level prototype ----------

function Prototype({ variant, ...props }: { variant: VariantKey } & Props) {
  const push = usePush(props.vapidKey);
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <>
      <FeedDrawer
        open={drawerOpen}
        setOpen={setDrawerOpen}
        push={push}
        showFeedAsk={variant === "B"}
      />
      {variant === "A" && <ContextAsk push={push} role={props.role} />}
      {variant === "C" && <ArrivalAsk push={push} />}
      {push.fakePrompt && <FakeBrowserPrompt onAnswer={push.fakePrompt} />}
      <PrototypeBar variant={variant} push={push} {...props} />
    </>
  );
}

// ---------- A: ask in context ----------

function ContextAsk({ push, role }: { push: Push; role: string }) {
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const [moment, setMoment] = useState<null | "question" | "refund" | "instructor" | "admin">(null);

  // Moment 1: just asked a Discussion Question (event from the comment form).
  useEffect(() => {
    const on = (e: Event) => setMoment((e as CustomEvent).detail);
    window.addEventListener("prototype:push-moment", on);
    return () => window.removeEventListener("prototype:push-moment", on);
  }, []);

  // Moment 2: just raised a Refund Request (redirected with ?pushMoment=refund).
  // Moment 3: on the page where you act on push Notifications.
  useEffect(() => {
    if (params.get("pushMoment") === "refund") {
      setMoment("refund");
      const p = new URLSearchParams(params);
      p.delete("pushMoment");
      setParams(p, { replace: true, preventScrollReset: true });
    } else if (location.pathname === "/instructor/questions" && role.startsWith("instructor")) {
      setMoment("instructor");
    } else if (location.pathname === "/admin/refunds" && role.startsWith("admin")) {
      setMoment("admin");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, params]);

  if (!moment || !push.mayAsk) return null;

  const copy = {
    question: {
      title: "Question posted. Want to know the moment it's answered?",
      body: "We'll send a push to this browser when the Instructor replies, even if Cadence isn't open.",
    },
    refund: {
      title: "Refund Request sent. Want to hear back right away?",
      body: "We'll send a push to this browser when it's approved or declined. You'll also get an email.",
    },
    instructor: {
      title: "Get a push when a Student asks a question?",
      body: "Students are waiting on your answers. We'll only push for new questions.",
    },
    admin: {
      title: "Get a push when a Refund Request is raised?",
      body: "Each one needs a decision. We'll only push for new Refund Requests.",
    },
  }[moment];

  return (
    <div className="fixed left-1/2 top-4 z-50 w-[min(32rem,calc(100%-2rem))] -translate-x-1/2 rounded-lg border bg-background p-4 shadow-lg">
      <div className="flex gap-3">
        <BellRing className="mt-0.5 size-5 shrink-0 text-primary" />
        <div className="flex-1">
          <p className="font-medium">{copy.title}</p>
          <p className="mt-1 text-sm text-muted-foreground">{copy.body}</p>
          <div className="mt-3 flex gap-2">
            <button
              className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground"
              onClick={async () => {
                setMoment(null);
                await turnOnWithFeedback(push);
              }}
            >
              Turn on push
            </button>
            <button
              className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted"
              onClick={() => {
                push.snooze();
                setMoment(null);
              }}
            >
              Not now
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- C: ask when one arrives ----------

function ArrivalAsk({ push }: { push: Push }) {
  const data = useFeedData();
  const seen = useRef<Set<string> | null>(null);
  const asked = useRef(false);

  useEffect(() => {
    if (!data || data.isFirstFetch) return;
    const list = data.notifications ?? [];
    const unread = list.filter((n) => !n.read_on);
    let trigger: IRemoteNotification | undefined;
    if (seen.current === null) {
      // On load: an unread Notification waiting for you counts as "arrived".
      trigger = unread[0];
      seen.current = new Set(list.map((n) => n.n_id));
    } else {
      trigger = unread.find((n) => !seen.current!.has(n.n_id));
      list.forEach((n) => seen.current!.add(n.n_id));
    }
    if (!trigger || asked.current || !push.mayAsk) return;
    asked.current = true;
    toast(trigger.message.header ?? "New Notification", {
      description: "This could have reached you as a push, even with Cadence closed. Turn on push for this browser?",
      duration: Infinity,
      action: { label: "Turn on push", onClick: () => turnOnWithFeedback(push) },
      cancel: { label: "Not now", onClick: () => push.snooze() },
    });
  }, [data, push]);

  return null;
}

// ---------- the Notification Feed drawer (feed prototype variant B) ----------

function openNotification(n: IRemoteNotification) {
  if (n.message.url) window.location.assign(n.message.url);
}

function FeedDrawer({
  open,
  setOpen,
  push,
  showFeedAsk,
}: {
  open: boolean;
  setOpen: (o: boolean) => void;
  push: Push;
  showFeedAsk: boolean;
}) {
  const feed = useFeedClient();
  const data = useFeedData();
  const notifications = data?.notifications ?? [];
  const unread = notifications.filter((n) => !n.read_on);
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
        {unread.length > 0 && (
          <span className="rounded-full bg-red-600 px-1.5 text-xs font-semibold text-white">
            {unread.length > 9 ? "9+" : unread.length}
          </span>
        )}
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

            {showFeedAsk && push.mayAsk && (
              <div className="flex gap-3 border-b bg-primary/5 px-4 py-3">
                <BellRing className="mt-0.5 size-5 shrink-0 text-primary" />
                <div className="flex-1 text-sm">
                  <p className="font-medium">Get these even when Cadence is closed</p>
                  <p className="text-muted-foreground">
                    Push only for things that need you: questions, replies and refunds.
                  </p>
                  <div className="mt-2 flex gap-2">
                    <button
                      className="rounded-md bg-primary px-3 py-1 text-primary-foreground"
                      onClick={() => turnOnWithFeedback(push)}
                    >
                      Turn on push
                    </button>
                    <button className="rounded-md px-3 py-1 text-muted-foreground hover:bg-muted" onClick={push.snooze}>
                      Not now
                    </button>
                  </div>
                </div>
              </div>
            )}

            <div className="flex-1 overflow-y-auto">
              {notifications.length === 0 && (
                <p className="p-8 text-center text-sm text-muted-foreground">You're all caught up.</p>
              )}
              {unread.length > 0 && <h3 className="bg-muted px-4 py-1 text-xs font-semibold uppercase">Unread</h3>}
              {unread.map((n) => <Row key={n.n_id} n={n} onOpen={onOpen} />)}
              {earlier.length > 0 && <h3 className="bg-muted px-4 py-1 text-xs font-semibold uppercase">Earlier</h3>}
              {earlier.map((n) => <Row key={n.n_id} n={n} onOpen={onOpen} />)}
            </div>

            <PushRow push={push} />
          </aside>
        </div>
      )}
    </>
  );
}

function Row({ n, onOpen }: { n: IRemoteNotification; onOpen: (n: IRemoteNotification) => void }) {
  return (
    <button onClick={() => onOpen(n)} className="flex w-full gap-3 border-b px-4 py-3 text-left hover:bg-muted">
      <span className={`mt-1.5 size-2 shrink-0 rounded-full ${n.read_on ? "bg-transparent" : "bg-primary"}`} />
      <span className="min-w-0 flex-1">
        {n.message.header && <span className="block text-sm font-medium">{n.message.header}</span>}
        <span className="block text-sm text-muted-foreground">{n.message.text}</span>
        <span className="mt-1 block text-xs text-muted-foreground">{new Date(n.created_on).toLocaleString()}</span>
      </span>
    </button>
  );
}

/** The one permanent place to turn push on or off, in every variant. */
function PushRow({ push }: { push: Push }) {
  const [help, setHelp] = useState(false);
  const { status } = push;
  return (
    <footer className="border-t px-4 py-3 text-sm">
      <div className="flex items-center gap-3">
        {status === "on" ? <BellRing className="size-4 text-primary" /> : <BellOff className="size-4 text-muted-foreground" />}
        <span className="flex-1">
          Push on this browser:{" "}
          <strong>
            {{ checking: "…", unsupported: "Not available", ask: "Off", on: "On", off: "Off", blocked: "Blocked" }[status]}
          </strong>
        </span>
        {(status === "ask" || status === "off") && (
          <button className="text-primary" onClick={() => turnOnWithFeedback(push)}>
            Turn on
          </button>
        )}
        {status === "on" && (
          <button className="text-muted-foreground" onClick={push.turnOff}>
            Turn off
          </button>
        )}
        {status === "blocked" && (
          <button className="text-primary" onClick={() => setHelp((h) => !h)}>
            How to unblock
          </button>
        )}
      </div>
      {status === "blocked" && help && (
        <p className="mt-2 text-muted-foreground">
          Your browser is blocking notifications from Cadence, and only it can undo that. Click the icon to the left of
          the address bar, set Notifications to Allow, then reload this page.
        </p>
      )}
      {status === "unsupported" && (
        <p className="mt-2 text-muted-foreground">
          This browser can't receive push. On iPhone or iPad, add Cadence to your Home Screen (Share → Add to Home
          Screen) and open it from there.
        </p>
      )}
    </footer>
  );
}

// ---------- simulated browser prompt ----------

function FakeBrowserPrompt({ onAnswer }: { onAnswer: (allow: boolean) => void }) {
  return (
    <div className="fixed left-4 top-2 z-[70] w-80 rounded-lg border border-zinc-300 bg-white p-4 text-sm text-zinc-900 shadow-2xl">
      <p className="mb-1 text-xs uppercase tracking-wide text-zinc-500">Simulated browser prompt</p>
      <p>
        <strong>{window.location.host}</strong> wants to
      </p>
      <p className="mt-1 flex items-center gap-2">
        <Bell className="size-4" /> Show notifications
      </p>
      <div className="mt-3 flex justify-end gap-2">
        <button className="rounded border px-3 py-1" onClick={() => onAnswer(false)}>
          Block
        </button>
        <button className="rounded bg-blue-600 px-3 py-1 text-white" onClick={() => onAnswer(true)}>
          Allow
        </button>
      </div>
    </div>
  );
}

// ---------- floating bar: variant switcher + simulation + state ----------

function PrototypeBar({
  variant,
  push,
  distinctId,
  userToken,
  role,
}: { variant: VariantKey; push: Push } & Props) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const client = useSuprSendClient();
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
      if (t.closest("input, textarea, select, [contenteditable]")) return;
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (process.env.NODE_ENV === "production") return null;

  return (
    <div className="fixed bottom-4 left-1/2 z-[60] flex -translate-x-1/2 flex-wrap items-center gap-3 rounded-full bg-zinc-900 px-4 py-2 text-xs text-white shadow-lg">
      <button onClick={() => go(-1)} aria-label="Previous variant">
        <ChevronLeft className="size-4" />
      </button>
      <span className="font-semibold">
        {variant} ({VARIANTS[variant]})
      </span>
      <button onClick={() => go(1)} aria-label="Next variant">
        <ChevronRight className="size-4" />
      </button>
      <span className="text-zinc-500">|</span>
      <label className="flex items-center gap-1">
        permission
        <select
          value={push.sim}
          onChange={(e) => push.setSim(e.target.value as Sim)}
          className="rounded bg-zinc-800 px-1 py-0.5"
        >
          {SIMS.map((s) => (
            <option key={s} value={s}>
              {s === "real" ? "real browser" : `sim: ${s}`}
            </option>
          ))}
        </select>
      </label>
      <span>
        push <strong>{push.status}</strong>
        {push.snoozed && " · snoozed"}
      </span>
      {push.snoozed && (
        <button className="underline" onClick={push.resetSnooze}>
          unsnooze
        </button>
      )}
      <span className="text-zinc-500">|</span>
      <span className="text-zinc-300">
        {distinctId} · {role} · token {userToken ? "✓" : "✗"} · {client.isIdentified(true) ? "identified" : "not identified"}
      </span>
    </div>
  );
}
