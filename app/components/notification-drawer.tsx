import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { Dialog } from "radix-ui";
import { Bell, X } from "lucide-react";
import { cn } from "~/lib/utils";

// The Notification Feed's bell and drawer, drawn with our own components and
// knowing nothing of SuprSend (docs/adr/0013): the client-only provider maps
// SuprSend's feed onto `FeedItem`s, and without SuprSend keys the bell is
// rendered here with no items.

export type FeedItem = {
  id: string;
  title: string | null;
  text: string;
  url: string | null;
  createdAt: number; // ms since the epoch
  read: boolean;
};

type NotificationBellProps = {
  items: FeedItem[];
  loading?: boolean;
  onMarkRead?: (item: FeedItem) => void;
  onMarkAllRead?: () => void;
  /** A row pinned to the foot of the drawer, e.g. the push setting. */
  footer?: ReactNode;
};

export function NotificationBell({
  items,
  loading = false,
  onMarkRead,
  onMarkAllRead,
  footer,
}: NotificationBellProps) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const unread = items.filter((item) => !item.read);
  const earlier = items.filter((item) => item.read);

  function openItem(item: FeedItem) {
    if (!item.read) onMarkRead?.(item);
    if (!item.url) return;
    setOpen(false);
    const target = new URL(item.url, window.location.href);
    if (target.origin === window.location.origin) {
      navigate(`${target.pathname}${target.search}${target.hash}`);
    } else {
      window.location.assign(target.toString());
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          className="fixed right-4 top-3 z-40 flex items-center gap-1 rounded-full border bg-background p-2 shadow-sm hover:bg-muted"
          aria-label={
            unread.length > 0
              ? `Notifications, ${unread.length} unread`
              : "Notifications"
          }
        >
          <Bell className="size-5" />
          <UnreadBadge count={unread.length} />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/30" />
        <Dialog.Content className="fixed inset-y-0 right-0 z-50 flex h-full w-full max-w-md flex-col bg-background shadow-xl focus:outline-none">
          <header className="flex items-center justify-between border-b px-4 py-3">
            <Dialog.Title className="font-semibold">Notifications</Dialog.Title>
            <Dialog.Description className="sr-only">
              Your Notifications, unread first.
            </Dialog.Description>
            <div className="flex items-center gap-3">
              <button
                type="button"
                className="text-sm text-primary disabled:text-muted-foreground"
                disabled={unread.length === 0}
                onClick={() => onMarkAllRead?.()}
              >
                Mark all read
              </button>
              <Dialog.Close aria-label="Close">
                <X className="size-5" />
              </Dialog.Close>
            </div>
          </header>
          <div className="flex-1 overflow-y-auto">
            {items.length === 0 && (
              <p className="p-8 text-center text-sm text-muted-foreground">
                {loading ? "Loading…" : "You're all caught up."}
              </p>
            )}
            <FeedSection title="Unread" items={unread} onOpen={openItem} />
            <FeedSection title="Earlier" items={earlier} onOpen={openItem} />
          </div>
          {footer && <footer className="border-t">{footer}</footer>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function FeedSection({
  title,
  items,
  onOpen,
}: {
  title: string;
  items: FeedItem[];
  onOpen: (item: FeedItem) => void;
}) {
  if (items.length === 0) return null;
  return (
    <section>
      <h3 className="bg-muted px-4 py-1 text-xs font-semibold uppercase">
        {title}
      </h3>
      {items.map((item) => (
        <FeedRow key={item.id} item={item} onOpen={onOpen} />
      ))}
    </section>
  );
}

function FeedRow({
  item,
  onOpen,
}: {
  item: FeedItem;
  onOpen: (item: FeedItem) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(item)}
      className="flex w-full gap-3 border-b px-4 py-3 text-left hover:bg-muted"
    >
      <span
        className={cn(
          "mt-1.5 size-2 shrink-0 rounded-full",
          item.read ? "bg-transparent" : "bg-primary"
        )}
      />
      <span className="min-w-0 flex-1">
        {item.title && (
          <span className="block text-sm font-medium">{item.title}</span>
        )}
        <span className="block text-sm text-muted-foreground">{item.text}</span>
        <span className="mt-1 block text-xs text-muted-foreground">
          {new Date(item.createdAt).toLocaleString()}
        </span>
      </span>
    </button>
  );
}

function UnreadBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="rounded-full bg-red-600 px-1.5 text-xs font-semibold text-white">
      {count > 9 ? "9+" : count}
    </span>
  );
}
