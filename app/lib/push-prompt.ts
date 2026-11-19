// ─── The web push ask ───
// Cadence never asks for push on a first visit. It asks when a push-eligible
// Notification arrives in the feed, or is still unread when a page loads.

/** What the browser reports from `Notification.permission`. */
export type PushPermission = "default" | "granted" | "denied";

export type PushAskState = {
  permission: PushPermission;
  /** Whether this browser can receive push at all. */
  supported: boolean;
  /** The person used Turn off in the drawer, on this browser. */
  turnedOffInCadence: boolean;
  /** "Not now" snoozes the ask until then (ms since the epoch). */
  snoozedUntil: number | null;
  /** The ask shows at most once per page load. */
  askedThisPageLoad: boolean;
  /** The arriving or unread Notification goes out as a push too. */
  pushEligible: boolean;
  now: number;
};

const SNOOZE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** When a "Not now" given at `now` stops snoozing the ask. */
export function snoozeUntil(now: number) {
  return now + SNOOZE_DAYS * DAY_MS;
}

export function shouldAskForPush(state: PushAskState): boolean {
  return (
    state.pushEligible &&
    state.permission === "default" &&
    state.supported &&
    !state.turnedOffInCadence &&
    !state.askedThisPageLoad &&
    (state.snoozedUntil === null || state.now >= state.snoozedUntil)
  );
}

// ─── This browser's push preferences ───
// "Not now" and Turn off are per-browser conveniences kept in localStorage.
// A store that is missing or throws (private windows, blocked site data)
// reads as "never asked".

const SNOOZED_UNTIL_KEY = "cadence:push-ask-snoozed-until";
const TURNED_OFF_KEY = "cadence:push-turned-off";

function read(key: string) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Nothing to keep it in: the ask may come back on a later page load.
  }
}

export const pushPreferences = {
  snoozedUntil(): number | null {
    const value = Number(read(SNOOZED_UNTIL_KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  },
  snooze(now: number) {
    write(SNOOZED_UNTIL_KEY, String(snoozeUntil(now)));
  },
  turnedOffInCadence(): boolean {
    return read(TURNED_OFF_KEY) === "true";
  },
  setTurnedOffInCadence(turnedOff: boolean) {
    write(TURNED_OFF_KEY, turnedOff ? "true" : null);
  },
};
