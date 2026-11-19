import { serviceWorkerScript } from "~/lib/notification-feed.server";

// The browser registers this as the push service worker (see
// notification-feed.client.tsx). It must be served from the site root so
// its scope covers every page.
export function loader() {
  return new Response(serviceWorkerScript(), {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      // The browser checks for a new worker on each visit.
      "Cache-Control": "no-cache",
    },
  });
}
