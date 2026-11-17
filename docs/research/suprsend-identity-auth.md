# SuprSend user identity and feed authentication

Researched 2026-11-17 for #13, against SuprSend's docs (docs.suprsend.com, read as the `.md` pages its `llms.txt` index serves) and the source of its SDKs on GitHub:

- `@suprsend/web-sdk` 5.4.0 ([suprsend-web-sdk @ 0b3b8cc](https://github.com/suprsend/suprsend-web-sdk/tree/0b3b8cc08c))
- `@suprsend/react-core` 2.4.0 ([suprsend-react-core @ b8b2adf](https://github.com/suprsend/suprsend-react-core/tree/b8b2adfea6)), which depends on `@suprsend/web-sdk ^5.4.0`
- `@suprsend/node-sdk` 1.15.1 ([suprsend-node-sdk @ 8ac5db0](https://github.com/suprsend/suprsend-node-sdk/tree/8ac5db0a30))

These match the latest versions on npm on that date. Where the docs and the code disagree, or the docs are silent, this note goes by the code and says so. Anything I could not confirm from a primary source is marked **[unverified]**.

## Question

How does SuprSend identify and authenticate a user, for a Node server plus headless React hooks in the browser?

- Creating and updating users from the server: the user id, setting email and name, and whether a user must exist before a workflow triggers to them.
- Enhanced security for the headless hooks and Inbox: how the signed user token is minted (signing key, claims, expiry, refresh), and what happens without it.
- Switching users in one browser (Cadence's DevUI user switcher, shared machines): what reset or logout does to the feed connection and to the browser's web push subscription.

## TL;DR

- **One id everywhere.** A SuprSend user is a `distinct_id`, scoped to a workspace (staging and production are separate user sets). SuprSend says to use an immutable id from your own database, not an email address. The same string is the server's recipient id, the `entity_id` in the signed token, and the `distinctId` prop in the browser.
- **Users don't have to exist before a workflow trigger.** The direct workflow trigger upserts every recipient listed inline, with email, name and other properties, "in the background". `$skip_create: true` turns that off. Event-based triggers are different: they need the user to exist already.
- **Enhanced security is a switch on each public key.** When it is on, every client request must carry an **ES256 JWT** that your backend signs with the workspace's **signing key**. The token carries `entity_type: "subscriber"`, `entity_id: <distinct_id>`, `exp`, `iat` and an optional `scope.tenant_id`. The Node SDK has no helper for this, so the docs use `jsonwebtoken`. The browser SDK calls `refreshUserToken` to get a new token: when a request is made within 30 seconds of `exp`, and when the feed socket is rejected with an auth error.
- **Without enhanced security, the public key plus any `distinct_id` is enough.** Anyone holding the public key (it ships in the bundle) can read and act on any user's feed and edit that user's profile from the browser. SuprSend says public keys alone are "insecure" for production. The Notification Feed prototype ran in that mode.
- **Switching users in React: changing `distinctId` on `SuprSendProvider` resets the old client and identifies the new user.** Resetting closes and removes the old user's feed socket and feed instances. By default it also **detaches this browser's push subscription from the old user's profile**, but it **does not unsubscribe the browser**. The next `identify` then **attaches that same browser subscription to the new user automatically**, with no new permission prompt. So on a shared browser, web push belongs to whoever was identified there last.
- **A logout that never runs `reset()`** (for example a full page load that mounts the provider with no user) leaves the subscription on the previous user's profile. That user's pushes keep arriving in that browser. This is inferred from the code.

## 1. Identity: `distinct_id`

- "SuprSend identifies users with immutable `distinct_id`. It's best to map the same identifier in your DB with `distinct_id` in SuprSend. Do not use identifiers that can be changed like email or phone number." ([Node: Manage Users](https://docs.suprsend.com/docs/node-create-user-profile.md))
- "Users are workspace-scoped — a `distinct_id` in your staging workspace is a different user from the same `distinct_id` in production." ([Users](https://docs.suprsend.com/docs/users.md))
- A profile holds channel identities (`$email`, `$sms`, `$webpush`, …), custom properties and preferences ([Users](https://docs.suprsend.com/docs/users.md)). The Node SDK's channel keys are `$email`, `$sms`, `$androidpush`, `$iospush`, `$whatsapp`, `$webpush`, `$slack` and `$ms_teams` ([`user_edit_internal_helper.js`](https://github.com/suprsend/suprsend-node-sdk/blob/8ac5db0a30/src/user_edit_internal_helper.js#L4-L21)).
- **Name is not a reserved field.** Every SuprSend example sets it as an ordinary custom property, `name` (for example `user.set("name", "John Doe")`), and templates read it as `$recipient.name` ([Node: Manage Users](https://docs.suprsend.com/docs/node-create-user-profile.md), [Node: Trigger workflow](https://docs.suprsend.com/docs/node-trigger-workflow-from-api.md)). The client SDK ignores property keys that start with `$` or `ss_` ([JS events and user methods](https://docs.suprsend.com/docs/js-events-and-user-methods.md)).
- Timezone (`$timezone`, IANA) and language (`$preferred_language`, ISO 639-1) are reserved, optional properties ([Node: Trigger workflow](https://docs.suprsend.com/docs/node-trigger-workflow-from-api.md)).

## 2. Creating and updating users from the Node server

**Auth.** The Node SDK is built with a workspace key and secret: `new Suprsend(workspace_key, workspace_secret)`. It signs each request with HMAC-SHA256 over the method, the body MD5, the content type, the date and the path ([`index.js`](https://github.com/suprsend/suprsend-node-sdk/blob/8ac5db0a30/src/index.js#L64-L90), [`signature.js`](https://github.com/suprsend/suprsend-node-sdk/blob/8ac5db0a30/src/signature.js)). This is separate from the client-side public key and signing key.

**Upsert.** Every route "upsert[s] against `distinct_id` — creating the profile the first time, patching it on subsequent calls. Keys you send are updated; keys you omit stay as they were." ([Users](https://docs.suprsend.com/docs/users.md)). The HTTP API is `POST https://hub.suprsend.com/v1/user/{distinct_id}/`, documented as "create if not exists, update if exists" ([Create / Update Users](https://docs.suprsend.com/reference/create-update-users.md)).

The Node SDK 1.15.1 has three ways to write a user:

```js
// 1. Edit instance (the current Node docs page)
const user = supr_client.users.get_edit_instance("u_123");
user.add_email("ada@example.com");
user.set("name", "Ada Lovelace");
await supr_client.users.edit(user);

// 2. Raw upsert (users_api.js)
await supr_client.users.upsert("u_123", { "$email": ["ada@example.com"], name: "Ada Lovelace" });

// 3. Older factory (still exported, shown on the general Users page)
const u = supr_client.user.get_instance("u_123"); u.add_email(...); await u.save();
```

Sources: [Node: Manage Users](https://docs.suprsend.com/docs/node-create-user-profile.md), [`users_api.js`](https://github.com/suprsend/suprsend-node-sdk/blob/8ac5db0a30/src/users_api.js#L76-L96) (`upsert`, `edit`, `get`, `delete`, `merge`, `get_edit_instance`), and [`index.js` `get user()`](https://github.com/suprsend/suprsend-node-sdk/blob/8ac5db0a30/src/index.js#L108-L110).

- **Removing a channel:** `user.remove_email(...)`, or `user.unset("$webpush")` to drop *every* web push token on the user ([Node: Manage Users](https://docs.suprsend.com/docs/node-create-user-profile.md), [`user_edit.js` add/remove_webpush](https://github.com/suprsend/suprsend-node-sdk/blob/8ac5db0a30/src/user_edit.js#L321-L331)). The server can therefore clear a user's push subscriptions without the browser's help.
- **Deleting a user:** `supr_client.users.delete(distinct_id)` ([`users_api.js`](https://github.com/suprsend/suprsend-node-sdk/blob/8ac5db0a30/src/users_api.js#L190)). This is relevant to the ADR's "deletion on request" consequence.
- SuprSend's own guidance: "For most B2B products, sync from the backend on write (signup, plan change) and use the client SDK only for push-token registration and events." ([Users](https://docs.suprsend.com/docs/users.md))

### Must the user exist before a workflow trigger?

- **Direct workflow trigger (`supr_client.workflows.trigger(new WorkflowTriggerRequest(body))`): no.** "It is a unified API to trigger workflow and doesn't require user creation before hand to trigger notification." ([Node: Trigger workflow](https://docs.suprsend.com/docs/node-trigger-workflow-from-api.md))
  - `recipients` takes up to 100 entries. Each is either a bare `distinct_id` string "(if the user is pre-synced)" or an inline object: `{ distinct_id, $email: [...], name, $timezone, $preferred_language, $channels, ...custom }`.
  - With an inline object, "the recipient will be automatically created in the SuprSend database in the background" ([same page](https://docs.suprsend.com/docs/node-trigger-workflow-from-api.md)). The Users page says "SuprSend upserts the user before sending" ([Users](https://docs.suprsend.com/docs/users.md)).
  - `"$skip_create": true` on a recipient or actor prevents that automatic creation ([same page](https://docs.suprsend.com/docs/node-trigger-workflow-from-api.md)). **[unverified]** What happens when you combine `$skip_create` with a `distinct_id` that doesn't exist: whether the inline channels are still used for that one send, or the recipient is dropped.
  - `actor` (the user who did the action, available as `$actor.<prop>`) is upserted the same way ([same page](https://docs.suprsend.com/docs/node-trigger-workflow-from-api.md)).
  - `is_transient: true` sends to a recipient that is never stored ([Users](https://docs.suprsend.com/docs/users.md)).
- **Event-based trigger (`track_event`): yes.** "User needs to be created beforehand for event based triggers." ([Trigger workflow](https://docs.suprsend.com/docs/trigger-workflow.md))
- **[unverified]** What happens when a bare `distinct_id` string is sent for a user that has never been synced. Presumably the user is auto-created with no channels, so only the Inbox channel (which needs no address) could deliver. I did not find this stated.

## 3. Client authentication and enhanced security

### Public key and secure mode

- Client SDKs authenticate with a **public API key** (Dashboard → Developers → API Keys → Public Keys). "For production workspaces public API Keys alone isn't enough as they are insecure. To solve this enable enhanced secure mode switch which you can find beside Public Key." ([Client authentication](https://docs.suprsend.com/docs/client-authentication.md))
- Secure mode is a flag on **each public key**: `is_secure_mode_enabled`, toggled with `PATCH /v1/{workspace}/ws_public_key/{public_key_id}/`. A public key also has an `allowed_domains` list ([Enable/Disable Secure Mode on Public Key](https://docs.suprsend.com/reference/patch-workspace-public-key.md)). So staging and production each have their own keys and their own switch.
- "When enhanced security mode is on, user level authentication is performed for all requests … All requests will be rejected by SuprSend if enhanced security mode is on and signed user token is not provided." ([Client authentication](https://docs.suprsend.com/docs/client-authentication.md))

### The signing key

- Generate it in the Dashboard, below Public Keys, or with `POST /v1/{workspace}/ws_signing_key/`. It is shown **only once**, in two forms of the same key: Base64 (a single line, convenient for an env var) and PEM. "Only **one active** signing key is allowed per workspace." ([Client authentication](https://docs.suprsend.com/docs/client-authentication.md), [Create Workspace Signing Key](https://docs.suprsend.com/reference/create-workspace-signing-key.md))
- Rotation is `POST …/ws_signing_key/{uid}/roll/`. It generates a new key, and "the previous key is marked `rolled`" ([Roll Workspace Signing Key](https://docs.suprsend.com/reference/roll-workspace-signing-key.md)). **[unverified]** Whether tokens signed with a rolled key keep working until they expire, or fail straight away.

### Minting the signed user token (server only)

From [Client authentication](https://docs.suprsend.com/docs/client-authentication.md):

- **Algorithm:** ES256, using the signing key in PEM form. If you stored the Base64 form, decode it to PEM first.
- **Payload:**

  ```json
  {
    "entity_type": "subscriber",          // hardcoded
    "entity_id": "<distinct_id>",
    "exp": 1725814228,                    // unix seconds
    "iat": 1725814228,                    // unix seconds
    "scope": { "tenant_id": ["..."] }     // optional, multi-tenant only
  }
  ```

- **`scope`:** "If you omit scope or set it to null, inbox and preferences fall back to the default tenant." If you list specific tenant ids, every SDK `identify` must also pass a matching `tenantId`, or requests fail with `401`.
- **Node example from the docs:**

  ```js
  import jwt from 'jsonwebtoken';
  const secret = Buffer.from(process.env.SUPRSEND_SIGNING_KEY_B64, 'base64').toString('utf-8'); // -> PEM
  const token = jwt.sign({ entity_type: 'subscriber', entity_id: userId, exp }, secret, { algorithm: 'ES256' });
  ```

  The docs' own Node sample leaves `iat` out, even though the payload table lists it. `jsonwebtoken` adds `iat` by default anyway. **[unverified]** Whether SuprSend rejects a token that has no `iat`.
- **The Node SDK has no token-minting helper.** Its source has no JWT code ([suprsend-node-sdk/src](https://github.com/suprsend/suprsend-node-sdk/tree/8ac5db0a30/src)). Cadence would need `jsonwebtoken` or `jose`.
- **[unverified]** SuprSend documents no maximum or recommended token lifetime.

### Using the token in the browser

- `SuprSendProvider` props: `publicApiKey` (required), `distinctId`, `userToken` ("Mandatory when enhanced security mode is on"), `refreshUserToken(oldUserToken, tokenPayload) => Promise<string>`, `tenantId`, `vapidKey`, `swFileName`, `host`, `createUser`, `userAuthenticationHandler` ([React integration](https://docs.suprsend.com/docs/react-sdk.md), [react-core `interface.ts`](https://github.com/suprsend/suprsend-react-core/blob/b8b2adfea6/src/interface.ts)).
- **HTTP calls** send `Authorization: <publicApiKey>`, plus `x-ss-signature: <userToken>` when a token is set ([web-sdk `api.ts` L19-34](https://github.com/suprsend/suprsend-web-sdk/blob/0b3b8cc08c/src/api.ts#L19-L34)).
- **The feed socket** (socket.io to `https://betainbox.suprsend.com`) sends `{ authorization: publicApiKey, 'x-ss-signature': userToken, distinct_id, tenant_id }` in its handshake. Feed HTTP calls go to `https://inboxs.live` with `distinct_id` as a query parameter ([web-sdk `feed.ts` L39-50, L794-808](https://github.com/suprsend/suprsend-web-sdk/blob/0b3b8cc08c/src/feed.ts#L794-L808)).
- **`identify` creates the user from the browser.** The first `identify` for a `distinctId` sends a `$identify` event that creates the user, unless `createUser: false` is passed. It then remembers the id in `localStorage['ss_distinct_id']` so that reloads skip the call ([web-sdk `main.ts` L150-185](https://github.com/suprsend/suprsend-web-sdk/blob/0b3b8cc08c/src/main.ts#L150-L185)). `createUser` is in the code and the types but not described in the docs.

### Expiry and refresh (from the code)

- **HTTP requests.** Before each request, `refreshExpiringUserToken()` decodes the JWT. If `exp` is within **30 seconds**, it calls `refreshUserToken(old, payload)` once (concurrent requests share one in-flight call) and re-identifies with the new token. There is **no background timer**: refresh happens only when a request is made. If the callback throws or returns something that is not a string, the old token is kept and the request goes out anyway ([web-sdk `api.ts` L75-128](https://github.com/suprsend/suprsend-web-sdk/blob/0b3b8cc08c/src/api.ts#L75-L128)).
- **Feed socket.** On a `connect_error` with the message `Authentication Error: wrong auth token`, the feed calls the same refresh. If the token changed, it swaps the token into the socket's auth and reconnects after 1 second ([web-sdk `feed.ts` L232-261](https://github.com/suprsend/suprsend-web-sdk/blob/0b3b8cc08c/src/feed.ts#L232-L261)). Without a `refreshUserToken` callback, the socket stays failed.
- **Feed health.** The feed reports a 401 or 403 on its first load as `reachability.status = AUTH_ERROR` (opt in with the `reachability` prop on `SuprSendFeedProvider`) ([JS in-app feed](https://docs.suprsend.com/docs/js-inapp-feed.md), [React headless feed](https://docs.suprsend.com/docs/react-sdk-headless-feed.md)).
- **Changing the `userToken` prop** on `SuprSendProvider` only sets `client.userToken`. It does not re-identify, and it does not update a socket that is already open, because the socket copied the token at creation ([react-core `SuprSendProvider.tsx` L110-114](https://github.com/suprsend/suprsend-react-core/blob/b8b2adfea6/src/core/context/SuprSendProvider.tsx#L110-L114)). Rotating tokens therefore depends on `refreshUserToken`.

### What happens without enhanced security

- The browser needs only the public key and a `distinctId`, and both are visible in the bundle and the network tab. SuprSend checks nothing else on the request. In practice, anyone who reads the key can `identify` as any `distinct_id` and then:
  - read and mark that user's feed (the socket and the `inboxs.live` calls are keyed by `distinct_id`);
  - add or remove that user's email, SMS or web push channels;
  - change that user's preferences;
  - `track` events as that user.

  ([Client authentication](https://docs.suprsend.com/docs/client-authentication.md): "insecure"; the method list is from [JS events and user methods](https://docs.suprsend.com/docs/js-events-and-user-methods.md).) This is what the prototype ran with.
- **Service worker caveat.** SuprSend's `serviceworker.js` reports `$notification_delivered`, `$notification_clicked` and `$notification_dismiss` by POSTing to `/v2/event` with **only** the public key, never a user token ([web-sdk `public/serviceworker.js` L60-72, L82-143](https://github.com/suprsend/suprsend-web-sdk/blob/0b3b8cc08c/public/serviceworker.js#L60-L72)). **[unverified]** Whether these analytics events are accepted once secure mode is on. Showing the notification does not depend on them.

## 4. Switching users in one browser

### What the SDK does (from the code)

**`client.identify(newId)` while another user is identified is refused** with "User already loggedin, reset current user to login new user". You must call `reset()` first ([web-sdk `main.ts` L108-116](https://github.com/suprsend/suprsend-web-sdk/blob/0b3b8cc08c/src/main.ts#L108-L116)).

**`client.reset({ unsubscribePush = true })`** ([web-sdk `main.ts` L290-310](https://github.com/suprsend/suprsend-web-sdk/blob/0b3b8cc08c/src/main.ts#L290-L310)):

1. If `unsubscribePush` (the default), it reads the browser's current `PushSubscription` and calls `user.removeWebPush(subscription)`. That **removes the `$webpush` entry from the old user's SuprSend profile**, using the old user's credentials, since it runs before they are cleared. It then deletes `localStorage['ss_wp_hash']`.
   - It **does not call `PushSubscription.unsubscribe()`**. The browser stays subscribed and the notification permission stays `granted` ([web-sdk `webpush.ts` L151-161](https://github.com/suprsend/suprsend-web-sdk/blob/0b3b8cc08c/src/webpush.ts#L151-L161)).
2. It clears `distinctId`, `userToken`, `tenantId`, the API client and cached preferences.
3. It calls `feeds.removeAll()`. Each feed instance's `remove()` clears its store, drops its listeners and timers, and **disconnects its socket** ([web-sdk `feed.ts` L1252-1264](https://github.com/suprsend/suprsend-web-sdk/blob/0b3b8cc08c/src/feed.ts#L1252-L1264)).
4. It does **not** clear `localStorage['ss_distinct_id']`; that line is commented out in the source. This only decides whether the next `identify` for the same id skips the `$identify` call.

**`client.identify(newId, token)` after a reset** calls `webpush.updatePushSubscription()` on success, and also on the "already logged in" path. If the browser already has a push subscription, it is **attached to the newly identified user** (`addWebPush`). The attach is skipped only when `sha256(endpoint::distinctId::tenantId)` matches the stored `ss_wp_hash`. No permission prompt and no user action are involved ([web-sdk `main.ts` L154-181](https://github.com/suprsend/suprsend-web-sdk/blob/0b3b8cc08c/src/main.ts#L154-L181), [`webpush.ts` L37-55, L139-149](https://github.com/suprsend/suprsend-web-sdk/blob/0b3b8cc08c/src/webpush.ts#L37-L55)).

**`registerPush()`** (user gesture → permission → `pushManager.subscribe` with the VAPID key → `addWebPush`) is needed only once per browser. If a subscription already exists, it just attaches it to the current user ([`webpush.ts` L57-113](https://github.com/suprsend/suprsend-web-sdk/blob/0b3b8cc08c/src/webpush.ts#L57-L113)).

### What `@suprsend/react-core` does on a `distinctId` change

- **`SuprSendProvider`** has an effect keyed on `[distinctId]` ([`SuprSendProvider.tsx` L96-108](https://github.com/suprsend/suprsend-react-core/blob/b8b2adfea6/src/core/context/SuprSendProvider.tsx#L96-L108)):
  - Its **cleanup** calls `reset()` on the old client if that client is identified, so with the default `unsubscribePush: true`. The cleanup does not await it.
  - Its **body** then creates a **new** `SuprSend` client and identifies the new `distinctId`.
  - Passing `distinctId={null}` or `undefined` is documented as "kind of logout": the old client is reset and nothing new is identified ([React integration](https://docs.suprsend.com/docs/react-sdk.md)).
- **`useAuthenticateUser().authenticateUser(...)`** does the same thing imperatively: `reset()` if a different user is identified, then `identify` ([`useAuthenticateUser.ts` L20-38](https://github.com/suprsend/suprsend-react-core/blob/b8b2adfea6/src/core/hooks/useAuthenticateUser.ts#L20-L38)).
- **`SuprSendFeedProvider`** re-initializes when `authenticatedUser` changes ([`SuprSendFeedProvider.tsx` L38-85](https://github.com/suprsend/suprsend-react-core/blob/b8b2adfea6/src/feed/context/SuprSendFeedProvider.tsx#L38-L85)):
  1. It removes the old feed, which disconnects its socket.
  2. If there is a new user, it opens a new feed and a new socket for that user, and fetches the first page.

  The old user's notifications are therefore not left in the store.

### What this means for the scenarios in the ticket

These are inferences from the code above, not documented guarantees.

| Scenario | Feed | Browser push subscription |
| --- | --- | --- |
| DevUI switches A → B in place (React Router `<Form>` to `/api/switch-user`, then a redirect: a client-side navigation, so the provider stays mounted and its `distinctId` prop changes) | A's socket closes; B's feed opens with B's token | Removed from A's profile, then **attached to B's profile automatically** if this browser had subscribed earlier |
| Logout that renders the provider with `distinctId={null}` in the same JS session | Socket closed, store cleared | Removed from A's profile; the browser stays subscribed and attaches to whoever is identified next |
| Logout or user change via a **full page load** (the provider mounts fresh, so no cleanup runs) | Nothing is open to close | **Stays on A's profile.** A's web pushes keep arriving in this browser until something removes it: a later `reset()` in this browser, or the server calling `unset("$webpush")` / `remove_webpush` for A |
| Shared machine where B never opted in | B's feed only | B still receives web push in this browser, because the subscription carries over from A without a prompt |
| `reset({ unsubscribePush: false })` (only through the web-sdk client; react-core's provider always uses the default) | Socket closed | Stays on A's profile and is *also* attached to B at B's identify. **[unverified]** Whether SuprSend lets one endpoint sit on two profiles; the client-side code doesn't stop it |

Other points:

- **Every switch in place also has to swap the signed token.** B needs a token whose `entity_id` is B's id. The provider identifies with whatever `userToken` prop it has when its `[distinctId]` effect runs (the body is deferred with `setTimeout(0)`), so the prop has to change in the same render as `distinctId`.
- **React StrictMode in development** runs effects twice: mount, cleanup, mount. The first cleanup `reset()`s, which removes the push subscription from the user, and the second mount identifies again and re-attaches it. Expect extra `$webpush` remove and add calls in development. This is inferred from the code.
- **The cleanup's `reset()` is not awaited.** Its `removeWebPush` for A can therefore run while the new client is attaching to B. Each call targets a different user, so the end state should be the same. The cleanup's late `removeLocalStorageData('ss_wp_hash')` can, however, wipe B's freshly written hash, which would only cause a redundant re-attach on B's next identify. This is inferred from the code.
- **Server-side cleanup option:** if Cadence wants push tied strictly to sign-in, the server can call `user.unset("$webpush")` or `remove_webpush(subscription)` for the departing user at logout ([Node: Manage Users](https://docs.suprsend.com/docs/node-create-user-profile.md)). In the browser, unsubscribing is possible only through the standard `PushSubscription.unsubscribe()`, which the SuprSend SDK never calls.

## Options this opens for Cadence (facts only, no recommendation)

- **Where users are created**
  - On the server when a Cadence user is created or edited (`users.edit` / `upsert`).
  - Inline on every workflow trigger (the recipient object with `$email` and `name`).
  - By the browser's `identify` (`$identify`, with `createUser` defaulting to true).

  These can be combined. With server sync, `createUser: false` stops the browser from creating users.
- **Token minting:** Cadence would need a small server endpoint or loader that signs `{ entity_type: "subscriber", entity_id, iat, exp }` with ES256 and the signing key, plus a `refreshUserToken` callback that calls it. Lifetime is Cadence's choice; SuprSend states no limit.
- **Secure mode can differ per key.** Cadence can turn it on for production only, or for staging too. DevUI switching works with either, as long as a token is minted for each switched-to user.
- **Push on shared browsers:**
  - accept that the subscription follows whoever is identified (the SDK default);
  - or clear it on logout from the server (`unset("$webpush")`), from the browser (`PushSubscription.unsubscribe()`), or both.

## Sources

Docs (docs.suprsend.com, fetched 2026-11-17):

- [Client authentication (enhanced security, signed user token)](https://docs.suprsend.com/docs/client-authentication.md)
- [API Keys and Secrets](https://docs.suprsend.com/docs/developer/api-keys.md)
- [Enable/Disable Secure Mode on Public Key](https://docs.suprsend.com/reference/patch-workspace-public-key.md)
- [Create Workspace Signing Key](https://docs.suprsend.com/reference/create-workspace-signing-key.md)
- [Roll Workspace Signing Key](https://docs.suprsend.com/reference/roll-workspace-signing-key.md)
- [React SDK integration (`SuprSendProvider`)](https://docs.suprsend.com/docs/react-sdk.md)
- [React headless feed](https://docs.suprsend.com/docs/react-sdk-headless-feed.md)
- [React WebPush](https://docs.suprsend.com/docs/react-webpush.md)
- [JS SDK integration (`identify`, `reset`)](https://docs.suprsend.com/docs/integrate-javascript-sdk.md)
- [JS WebPush](https://docs.suprsend.com/docs/js-webpush.md)
- [JS in-app feed](https://docs.suprsend.com/docs/js-inapp-feed.md)
- [JS events and user methods](https://docs.suprsend.com/docs/js-events-and-user-methods.md)
- [Users](https://docs.suprsend.com/docs/users.md)
- [Node: Manage Users](https://docs.suprsend.com/docs/node-create-user-profile.md)
- [Create / Update Users API](https://docs.suprsend.com/reference/create-update-users.md)
- [Node: Trigger workflow](https://docs.suprsend.com/docs/node-trigger-workflow-from-api.md)
- [Trigger workflow overview](https://docs.suprsend.com/docs/trigger-workflow.md)

Source code:

- [suprsend-web-sdk @ 0b3b8cc](https://github.com/suprsend/suprsend-web-sdk/tree/0b3b8cc08c) (v5.4.0): `src/main.ts`, `src/api.ts`, `src/webpush.ts`, `src/feed.ts`, `src/user.ts`, `public/serviceworker.js`
- [suprsend-react-core @ b8b2adf](https://github.com/suprsend/suprsend-react-core/tree/b8b2adfea6) (v2.4.0): `src/core/context/SuprSendProvider.tsx`, `src/core/hooks/useAuthenticateUser.ts`, `src/feed/context/SuprSendFeedProvider.tsx`, `src/interface.ts`
- [suprsend-node-sdk @ 8ac5db0](https://github.com/suprsend/suprsend-node-sdk/tree/8ac5db0a30) (v1.15.1): `src/index.js`, `src/users_api.js`, `src/user_edit.js`, `src/user_edit_internal_helper.js`, `src/signature.js`
