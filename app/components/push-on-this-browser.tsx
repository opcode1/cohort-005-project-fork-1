import { useState } from "react";
import { BellOff, BellRing } from "lucide-react";

// "Push on this browser": the drawer's footer row, the one place to turn web
// push on or off. It knows nothing of SuprSend (docs/adr/0013); the
// client-only feed module works out the status and does the turning.

export type PushStatus =
  | "checking"
  | "on"
  | "off" // never asked, snoozed, or turned off in Cadence
  | "blocked" // the browser denied permission; only it can undo that
  | "unavailable"; // e.g. iPhone Safari outside a Home Screen web app

const LABELS: Record<PushStatus, string> = {
  checking: "…",
  on: "On",
  off: "Off",
  blocked: "Blocked",
  unavailable: "Not available",
};

export const PUSH_BLOCKED_MESSAGE =
  "Push is blocked in this browser. Everything still arrives in Notifications (the bell).";

type PushOnThisBrowserProps = {
  status: PushStatus;
  /** False until the feed has identified the person to SuprSend. */
  ready: boolean;
  onTurnOn: () => Promise<void>;
  onTurnOff: () => Promise<void>;
};

export function PushOnThisBrowser({
  status,
  ready,
  onTurnOn,
  onTurnOff,
}: PushOnThisBrowserProps) {
  const [busy, setBusy] = useState(false);
  const [showUnblockSteps, setShowUnblockSteps] = useState(false);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="px-4 py-3 text-sm">
      <div className="flex items-center gap-3">
        {status === "on" ? (
          <BellRing className="size-4 text-primary" />
        ) : (
          <BellOff className="size-4 text-muted-foreground" />
        )}
        <span className="flex-1">
          Push on this browser: <strong>{LABELS[status]}</strong>
        </span>
        {status === "off" && (
          <button
            type="button"
            className="text-primary disabled:text-muted-foreground"
            disabled={!ready || busy}
            onClick={() => run(onTurnOn)}
          >
            Turn on
          </button>
        )}
        {status === "on" && (
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground"
            disabled={!ready || busy}
            onClick={() => run(onTurnOff)}
          >
            Turn off
          </button>
        )}
        {status === "blocked" && (
          <button
            type="button"
            className="text-primary"
            aria-expanded={showUnblockSteps}
            onClick={() => setShowUnblockSteps((shown) => !shown)}
          >
            How to unblock
          </button>
        )}
      </div>
      {status === "blocked" && showUnblockSteps && (
        <p className="mt-2 text-muted-foreground">
          Your browser is blocking notifications from Cadence, and only it can
          undo that. Click the icon to the left of the address bar, set
          Notifications to Allow, then reload this page.
        </p>
      )}
      {status === "unavailable" && (
        <p className="mt-2 text-muted-foreground">
          This browser can't receive push. On iPhone or iPad, add Cadence to the
          Home Screen and open it from there.
        </p>
      )}
    </div>
  );
}
