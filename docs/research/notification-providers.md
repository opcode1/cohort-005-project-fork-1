# Hosted notification providers for Cadence

Accessed: 2026-11-16. Sources are official vendor docs and pricing pages only. **[unverified]** marks claims I could not confirm on a primary page during this pass.

## Question

Which hosted provider (Knock, Novu Cloud, Courier, MagicBell, SuprSend) should Cadence use? Cadence is a React Router v7 SSR app on Node with SQLite/Drizzle, and it sells video courses. It needs an in-app Notification Feed and browser web push, possibly email, and no self-hosting.

## Summary

| | Knock | Novu Cloud | Courier | MagicBell | SuprSend |
|---|---|---|---|---|---|
| React feed | Components + headless hooks [1] | `<Inbox/>` + `@novu/react` hooks, React 18/19 [6] | `<CourierInbox/>` (`@trycourier/courier-react` v9) [10] | FloatingInbox / Inbox components [13] | `<Inbox/>` + headless (`@suprsend/react`) [17] |
| Browser web push | Only via FCM, no first-party channel [2] | Via FCM / OneSignal / Pushpad [7][8] | Via FCM [11] | **First-party** (`WebPushButton`, service worker) [13][14] | **First-party** (VAPID key, `registerPush()`) [18] |
| Email | Yes, via providers [3] | Yes [7, unverified detail] | Yes [12] | Yes [unverified] | Yes [unverified] |
| Feed auth | Signed user token, "enhanced security" [unverified] | HMAC `subscriberHash` [6] | Backend-minted JWT [10] | JWT / HMAC [13, partly unverified] | ES256 JWT from backend (HMAC deprecated for web) [19] |
| Free tier | 10k msgs/mo [4] | 10k workflow runs/mo [9] | 10k sends/mo [12] | 1k deliveries/mo [15] | 10k notifs/mo [20] |
| First paid tier | $250/mo for 50k, then $0.005/msg [4] | Pro from $30/mo for 30k+, Team $250/mo for 250k+, $1.20 per 1k extra [9] | $0.005 per send, every send billed [12] | $249/mo for 50k, then $0.0025 [15] | Essentials $100/mo for 50k, then $0.002 [20] |
| EU region | **No.** Expected "by end of 2026" [5] | **Yes, US + EU on Free** [9] | EU data residency listed on Business [12] | Not stated [16] | Enterprise only (multi-region / BYOC) [20] |
| SLA | 99.9% uptime; contractual SLA Enterprise only [4] | 99.9% listed, plan unclear [9] | Enterprise SLA only [12] | Not stated [15] | 99.9% uptime; SLA Enterprise only [20] |

All five offer workflows, digests/batching, user preferences and a Node SDK as core product features. I only checked this per page for Knock (preferences [1]) and Novu (preferences [6]), so treat the rest as **[unverified]**. None of the pages I fetched discuss SSR. The feed components are client-side, so in React Router v7 they would render client-only (for example, mounted after hydration) **[inference]**.

## Knock

- **React:** `NotificationFeedPopover`, `NotificationFeed`, `NotificationIconButton`, plus headless hooks and preferences [1].
- **Web push:** Knock "does not have a first-party web push channel". You send through FCM and store the browser token as channel data [2].
- **Pricing:** Free is 10k messages a month with no hard cap. Starter is $250 a month for 50k, then $0.005 per message. Enterprise is custom [4].
- **GDPR:** Knock has a GDPR certification and uses the DPF and SCCs. Data is stored in the US, and EU residency is "not yet available" [4][5].
- **Auth:** Knock uses signed user tokens ("enhanced security mode") **[unverified]**.

## Novu Cloud

- **React:** `<Inbox/>` combines Bell, Notifications and Preferences. Headless hooks come in `@novu/react`, and React 19 is supported [6].
- **Auth:** Updating an existing subscriber needs an HMAC `subscriberHash` [6].
- **Web push:** Delivered through push providers FCM, OneSignal or Pushpad [7][8].
- **Pricing:** Free is 10k runs. Pro starts at $30 a month for 30k+ runs, and Team at $250 a month for 250k+. Extra runs cost $1.20 per 1k [9].
- **Residency:** US and EU are available on Free. Enterprise adds more regions [9].

## Courier

- **React:** Courier v9 handles sign-in with a backend JWT, then renders `<CourierInbox/>` [10].
- **Web push:** Delivered through FCM, with tokens stored on the user profile. I found no web-specific React walkthrough [11].
- **Pricing:** Developer is free for 10k sends. On Business, every send costs $0.005, including the first 10k. Enterprise is custom [12].
- **Residency:** "EU Data Residency" is listed on Business [12].

## MagicBell

- **React components:** FloatingInbox, Inbox, ContextProvider and `WebPushButton` [13].
- **Web push:** First-party, using a service worker that imports MagicBell's script [13][14].
- **Pricing:** Builder is free for only 1k deliveries a month. Startup is $249 a month for 50k, then $0.0025 each [15].
- **GDPR:** MagicBell claims GDPR compliance and offers a DPA. No EU region is stated [16].

## SuprSend

- **React:** `@suprsend/react` provides `<Inbox/>` and headless options [17].
- **Web push:** First-party. You set a VAPID key, serve `/serviceworker.js` from the root, and call `registerPush()` on a user gesture [18].
- **Auth:** Your backend signs an ES256 JWT. The docs say not to use HMAC for new web integrations [19].
- **Pricing:** Free is 10k a month. Essentials is $100 a month for 50k, then $0.002 each. Business is $250 a month for 50k, then $0.005 each [20].
- **Residency:** Multi-region or a custom region is Enterprise only. GDPR badge [20].

## Viable vs not

- **Viable:** Novu Cloud, SuprSend, Courier, Knock. Knock only fits if EU residency is not required.
- **Weak:** MagicBell. Its free tier is 1k, and it states no EU region and no SLA.
- **Blocker to check:** If Cadence has EU learners and needs EU-hosted data, Knock is out today [5]. For SuprSend, only Enterprise qualifies [20].

## Recommendation

**Novu Cloud.** EU residency comes even on Free, and it has the cheapest path to scale ($30, then $250 with 250k runs). It has a React Inbox with headless hooks and preferences, and HMAC feed auth that is easy to add to a Node loader.
- **Trade-off:** Web push goes through FCM or OneSignal, which is an extra vendor and its own service worker.

**Runner-up: SuprSend.** It has first-party web push, a modern JWT auth model, and the cheapest 50k tier ($100).
- **Trade-off:** EU hosting is Enterprise only.

Pick SuprSend if native web push matters more than EU residency. Before you commit, prototype client-only rendering of the feed inside a React Router v7 route.

## Sources

1. https://docs.knock.app/in-app-ui/react/overview
2. https://docs.knock.app/tutorials/sending-web-push-notifications-with-fcm
3. https://docs.knock.app/integrations/overview
4. https://knock.app/pricing
5. https://docs.knock.app/manage-your-account/knock-plans ; https://knock.app/legal/privacy-policy
6. https://docs.novu.co/platform/inbox/overview
7. https://docs.novu.co/platform/integrations/push
8. https://docs.novu.co/platform/integrations/push/fcm ; https://docs.novu.co/platform/integrations/push/pushpad
9. https://novu.co/pricing
10. https://docs.courier.com/docs/courier-push
11. https://courier.com/docs/platform/channels/push/firebase-fcm
12. https://www.courier.com/pricing
13. https://www.magicbell.com/docs/libraries/magicbell-react
14. https://www.magicbell.com/web-push
15. https://www.magicbell.com/pricing
16. https://www.magicbell.com/security
17. https://docs.suprsend.com/docs/react-sdk
18. https://docs.suprsend.com/docs/react-webpush
19. https://docs.suprsend.com/docs/hmac-authentication
20. https://www.suprsend.com/pricing
