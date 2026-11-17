# SuprSend triggering and delivery semantics

Researched 2026-11-17 against primary sources: docs.suprsend.com (raw `.md` pages), the `suprsend/suprsend-node-sdk` source at commit `8ac5db0` (v1.15.1, the current npm release, published 2026-05-19), and suprsend.com/pricing. Anything not stated by one of those is marked **[unverified]**. This note reports facts and options. It makes no decisions for Cadence.

## Question

What are the semantics of triggering a SuprSend workflow from the Node SDK? Specifically: workflow trigger vs event trigger, idempotency keys and their window, what the API call confirms synchronously vs what happens asynchronously, error responses and retries (SDK and server side), rate limits and typical latency, and the batch/digest workflow nodes, including whether they are on the free tier.

## TL;DR

- **Two trigger types, one engine.** A *workflow trigger* (`POST /trigger/`, SDK `supr_client.workflows.trigger(new WorkflowTriggerRequest(body, opts))`) names a workflow slug and its recipients in code, and can upsert recipients inline. An *event trigger* (`POST /event/`, SDK `supr_client.track_event(new Event(distinct_id, name, props, opts))`) sends a named event. The dashboard maps that event to zero or more workflows, and the user must already exist in SuprSend. If the user doesn't exist, the event is **silently discarded with no error to the caller**.
- **Idempotency.** Both triggers take an optional `idempotency_key` (at most 255 chars, trimmed). Once SuprSend has processed a request with a key, it skips any request with the same key **for the next 24 hours**. The key is echoed in outbound webhooks and is searchable in the logs.
- **Sync vs async.** A successful call means **"accepted"** (`202`), not "delivered". Workflow execution, recipient upsert, preference checks, rendering and vendor delivery all happen asynchronously. Their failures show up only in the dashboard logs or outbound webhooks.
- **Errors and retries.** The API returns `400` for a malformed request and `404` when the workflow slug is not found. The **Node SDK never retries, sets no HTTP timeout, and never throws on HTTP failure**. Instead it resolves `{success:false, status_code, message}`, and maps network errors to a synthetic `500`. On the server side, retries are vendor fallback (paid feature) and webhook-node retries. These cover delivery only, not the trigger call.
- **Rate limits and latency.** No numeric API rate limit is published. Pricing says "a generous fair limit" applies, and SuprSend will contact you if volume looks abnormal. A bulk call counts as N calls. No latency figure or SLA is published below Enterprise **[unverified]**.
- **Batch and Digest nodes exist, but are not on Free or Essentials.** The pricing table lists "Batching & Digest" as a **Business plan ($250/mo, billed annually)** feature. Throttle appears to be excluded only on Free. A batched or digested notification bills as **one** notification.

## 1. Workflow trigger vs event trigger

Source: [Event vs Workflow API guide](https://docs.suprsend.com/docs/guides/event-vs-workflow-api.md), [Trigger Workflow API](https://docs.suprsend.com/reference/trigger-workflow-api.md), [Trigger an Event API](https://docs.suprsend.com/reference/trigger-event.md), SDK `src/workflow_api.js`, `src/event.js`.

| | Workflow trigger | Event trigger |
| --- | --- | --- |
| Endpoint | `POST https://hub.suprsend.com/trigger/` | `POST https://hub.suprsend.com/event/` |
| Node SDK | `supr_client.workflows.trigger(WorkflowTriggerRequest)` | `supr_client.track_event(Event)` |
| What code names | Workflow slug + recipients | Event name + `distinct_id` |
| Workflows started | Exactly one per recipient | Zero or more (dashboard mapping; "one event can fan out to many workflows") |
| User must pre-exist | No. Recipients defined inline are an **UPSERT** (`$skip_create: true` disables the upsert); `is_transient: true` sends to someone with no profile | **Yes.** "If the user doesn't exist in SuprSend already, the event is silently discarded. There's no error returned to the caller." |
| Recipients per call | Up to 100 (internally split into one workflow run per recipient) | One `distinct_id` |
| Slug mismatch | Call returns `404 workflow not found` | No workflow linked: shown only in the request logs |
| Optional fields | `tenant_id`, `idempotency_key`, `cancellation_key` (≤512 chars), `actor`, `data` | `tenant_id`, `idempotency_key`, `brand_id` (SDK). The HTTP API also accepts `cancellation_key`, **but the Node SDK `Event` class doesn't pass it** |
| Response | `202` JSON `{ "message_id": "...", "status": "success" }` | `202` plain text `OK` |

SuprSend's own guidance:

- Use the Workflow API for "critical-path notifications where silent failure is unacceptable" and for scheduled or digest jobs.
- Use events for user-action notifications and CDP pipelines.
- Each Workflow API call targets one workflow, so fanning out takes several calls or a wrapper.
- The guide also warns that inline recipient data upserted from triggers can overwrite profile fields set by a separate user sync.

Size limits, from SDK `src/constants.js`, enforced client-side before sending:

- Body: 800 KB.
- Bulk: 100 records per HTTP call. The SDK chunks larger bulks automatically.
- Base64 attachments: under 50 KB, per the API docs.

Legacy API: `supr_client.trigger_workflow(new Workflow(...))` posts to `/{workspace_key}/trigger/` with inline template, category and users. It is documented as the older form. New code uses `WorkflowTriggerRequest`.

### Bulk trigger

`supr_client.workflows.bulk_trigger_instance()` takes `.append(...)` and `.trigger()`. It posts a JSON array to the same `/trigger/` endpoint. The server returns **`207 Multi-Status` with a per-record `status`, `status_code` and `error`** ([Trigger Workflow API](https://docs.suprsend.com/reference/trigger-workflow-api.md)).

**SDK gap.** `src/workflow_trigger_bulk.js` (v1.15.1) marks *every* record in a chunk as `success` whenever axios does not throw. That includes a `207` whose body reports per-record errors. It never parses the `207` body, so a per-record failure such as `404 workflow not found` is reported to the caller as a success.

## 2. Idempotency

Sources:

- [Idempotent Requests](https://docs.suprsend.com/reference/idempotent-requests.md)
- [Node trigger doc §Idempotent requests](https://docs.suprsend.com/docs/node-trigger-workflow-from-api.md)
- [Execution Errors](https://docs.suprsend.com/docs/error-guides.md)
- API schema fields `$idempotency_key` on both endpoints

Rules and window:

- Pass `idempotency_key` in the SDK options. The SDK sends it as `$idempotency_key` in the body.
- It works on workflow triggers, events and broadcasts. The API schema says "valid for 24hrs".
- "If SuprSend receives and processes a request with an `idempotency_key`, it will skip processing requests with same `idempotency_key` for next 24 hours."
- The error guide puts it this way: "If SuprSend receives more than one request with the same idempotency_key in a 24 hour window, it will only process the first request and skip all other requests."
- The key is any string up to 255 characters. Leading and trailing spaces are trimmed.

Key strategies SuprSend suggests:

- A random UUID per request.
- A composite key, e.g. `user147-new-comment-1687437670`.
- An existing unique ID, such as an order ID or job ID.

A random UUID generated at send time does **not** protect against a retry that regenerates it. Only a key derived from the domain record survives a retry.

Uses beyond deduplication:

- The key is returned in every [outbound webhook](https://docs.suprsend.com/docs/outbound-webhook.md) payload as `reference.idempotency_key`.
- It is shown in the request logs and is the recommended way to trace one request across the request, execution and message logs.
- The [Cancel Workflow API](https://docs.suprsend.com/reference/cancel-workflow.md) can filter on it.

Scope:

- The docs say a duplicate is "logged as a request-level error in the request logs ('2 API requests have the same idempotency key')".
- **[unverified]** Whether the duplicate *HTTP response* is `202` or an error status. The docs don't say.
- **[unverified]** Whether the key is scoped per workspace (Staging vs Production) or per endpoint.
- **[unverified]** Whether a request that was *rejected* (`4xx`) consumes the key.
- With the 100-recipient form, one key covers the whole call, which is split into one run per recipient.

## 3. What the call confirms synchronously vs asynchronously

Sources: [Trigger Workflow API](https://docs.suprsend.com/reference/trigger-workflow-api.md) (`202` description), [Request logs](https://docs.suprsend.com/docs/request-logs.md), [Execution Errors](https://docs.suprsend.com/docs/error-guides.md), [Node trigger doc](https://docs.suprsend.com/docs/node-trigger-workflow-from-api.md).

**Synchronous (in the HTTP response).**

- The request is authenticated and well-formed. Bad requests get `400`.
- For workflow triggers, the slug exists (otherwise `404`).
- The payload passes the JSON schema, if one is linked to the workflow or event: "validates … and throws error in the API response if validation fails".
- Otherwise the call returns `202 Accepted`. In the API reference's words: "All workflow requests will be accepted as long as the API request is correct. To verify if the execution was successful, check the 'Requests' tab under the 'Logs' section."

**Asynchronous (visible only in the dashboard logs or outbound webhooks).**

Request-log statuses:

- "Completed" means only "that workflow run request was accepted by SuprSend".
- "Partial Failure" covers cases such as a trigger-condition mismatch.
- "Failed" covers "recipient not found", among others. A trigger condition that doesn't match shows up as "API request returns 200 but you don't see a workflow execution".

The async pipeline then runs:

1. Inline recipients are upserted "in the background".
2. Preferences are evaluated and channels computed.
3. Templates are rendered.
4. Messages are handed to vendors.
5. Delivered, seen and clicked statuses come back.

Errors in this pipeline go to the workflow execution logs and the message logs, not to the caller. "No user found with distinct_id" and "no active/preferred channels" are two examples ([Execution Errors](https://docs.suprsend.com/docs/error-guides.md)).

**Event-specific.** A missing user or an unlinked event never produces an error response. It shows up only as a discarded or failed entry in the request logs.

**Getting status back into your own system.** Two options:

- Outbound webhooks: per-channel status events with `idempotency_key`, `supr_execution_id`, vendor response, and a per-endpoint rate limit you configure ([Outbound Webhook](https://docs.suprsend.com/docs/outbound-webhook.md)).
- The Messages API (`supr_client.messages`) to list or query messages.

## 4. Errors and retries

### HTTP responses (trigger and event endpoints)

| Code | Meaning (from API reference) |
| --- | --- |
| `202` | Accepted (single trigger, event) |
| `207` | Bulk trigger; check each record |
| `400` | Bad request: malformed body or schema failure. Body `{status:"error", error:{message, type:"bad_request"}}` |
| `404` | Workflow slug not found (`type:"not_found"`) |
| `401` | Authentication failure. Documented on the Management API [errors page](https://docs.suprsend.com/docs/management-api-errors.md) and the logs. Exact trigger-endpoint body **[unverified]** |
| `5xx` | "Unexpected server error" (Management API errors page) |
| `429` | **Not documented anywhere [unverified]** |

### Node SDK behaviour

Source: `src/workflow_api.js`, `src/event.js`, `src/workflow_trigger_bulk.js` at v1.15.1.

- **No retries.** There is no retry or backoff code anywhere in `src/`.
- **No timeout.** `axios.post` is called without a `timeout`, and the axios default is `0`, meaning no timeout ([axios request config](https://github.com/axios/axios#request-config)). A hung connection holds the awaiting action until the OS gives up.
- **Doesn't throw on HTTP or network failure.** `workflows.trigger()` resolves `{ success, status: "success"|"fail", status_code, message }`:
  - Non-2xx responses give the server's status and body.
  - Network errors give **`status_code: 500`** with `err.message`. A network failure therefore looks like a server 500 unless you inspect `message`.
  - `track_event()` behaves the same way, except that its error status comes from `err.status`.
- **Throws synchronously on invalid input.** It raises `InputValueError` for a non-object body, a schema-invalid body, a body over 800 KB, or a reserved event name (`$…`, `ss_…`).
- **Signing.** Requests are HMAC-signed with the workspace secret over the method, body MD5, content type, `Date` header and URI. A badly skewed clock *may* cause auth failures **[unverified]**.
- **Type mismatch.** `types/index.d.ts` names the option `cancellation_id`, but the JS reads `cancellation_key`. TypeScript callers using the typed name would silently drop it.

### Server-side retries (delivery, not triggering)

- [Vendor Fallback](https://docs.suprsend.com/docs/vendor-fallback.md) moves a message to the next vendor if delivery fails, or if no delivery report arrives within the fallback time.
  - A "success metric" event stops the fallback, to avoid duplicates.
  - Pricing lists "Provider Fallback" as not on Free.
- The [Webhook node](https://docs.suprsend.com/docs/webhook.md) has "retry support" and a 15 s response limit.
- **[unverified]** Any documented automatic retry of a failed vendor send *without* fallback configured. Retry counts and schedules for outbound webhooks are also undocumented.
- SuprSend marks email and WhatsApp identities **inactive for 15 days** after hard bounces. Later sends to them fail with "no active channels" ([Execution Errors](https://docs.suprsend.com/docs/error-guides.md)).

## 5. Rate limits, volume and latency

- **Published API rate limit:** none found in the docs or on the pricing page **[unverified number]**.
  - Pricing FAQ: "we do not charge based on number of requests … However, to ensure smooth system performance, we have a generous fair limit on the number of requests allowed. If we detect an unusually high volume of requests … we will reach out."
  - Trigger API reference: "A bulk request counts as **N calls** (one per record), not one call, against your rate limit". So a limit exists but its value is not published.
- **Fan-out guidance:** use Lists and Broadcast for audiences over 1,000 users. "Sending individual workflows to a large set of users may introduce delays in your notification queue" ([Node trigger doc](https://docs.suprsend.com/docs/node-trigger-workflow-from-api.md)).
- **Queues:** SuprSend keeps separate queues per root category (System, Transactional, Promotional) "to ensure that marketing and promotional notifications don't delay system or time-sensitive notifications" ([Notification Category](https://docs.suprsend.com/docs/notification-category.md)).
- **Latency:**
  - No published figure for trigger-call latency or for time from trigger to delivery **[unverified]**.
  - "Enterprise SLAs" appear only on the Enterprise plan.
  - The vendor-fallback example (30 s fallback for OTP SMS) suggests sub-minute delivery is the intent for system notifications. That is not a guarantee.
  - Platform status: <https://status.suprsend.com>.
- **Free-tier overage:** "We do not stop processing and sending your notification requests. We will alert and contact you." ([pricing FAQ](https://www.suprsend.com/pricing))

## 6. Batch, Digest and Throttle nodes

All three are configured in the dashboard workflow editor, not in the trigger call. The trigger only supplies the data the node keys on.

### Batch ([docs](https://docs.suprsend.com/docs/batch.md))

**What gets batched.**

- On reaching the node, a batch opens for a **window**. Batches are unique per recipient + workflow slug + **batch key** (an optional event property, e.g. `post_id`).
- Triggers for the same recipient, slug and key that arrive while the window is open join the batch.
- When the window closes, **one** notification goes out per batch.

**Window types.**

- **Fixed**: `xxd xxh xxm xxs`.
- **Dynamic**: a JQ expression into the payload that gives seconds, an interval string or a future ISO timestamp. If the key is missing or invalid, the workflow stops.
- **Relative**: an offset before or after a future timestamp.
- Once a window opens, later triggers cannot extend it.

**Output and options.**

- `$batched_events` holds the properties of each batched trigger. It keeps the first or last *n* triggers, default 10, range 1–100.
- `$batched_events_count` is the full count.
- **Flush first item immediately** sends the first trigger right away and batches the rest.
- Joining triggers appear in the logs as "this event was added to the running batch of a pre-existing workflow", which is expected.

### Digest ([docs](https://docs.suprsend.com/docs/digest.md))

- Like Batch, but the batch closes on a **recurring schedule** rather than a window relative to the first trigger. One batch per recipient + workflow slug.
- **Schedules:** minutely, hourly, daily, weekly, weekday-only or monthly, with a time and timezone (fixed or the recipient's `$timezone`).
- **Dynamic schedule:** a per-user schedule can come from the trigger data, the recipient's profile or tenant properties.
- **Retain items:** 1–100, default 10.
- **Min trigger count:** the workflow exits without sending if too few triggers accumulated.
- If no triggers arrive in a period, nothing is sent.

### Throttle ([docs](https://docs.suprsend.com/docs/throttle.md))

- Set as a workflow setting: max executions per user per window.
- Triggers over the limit "will be discarded and will not result in workflow trigger".

### Plan availability

Source: [pricing page](https://www.suprsend.com/pricing), fetched 2026-11-17.

| Feature | Free ($0, 10k/mo) | Essentials ($100/mo annual, 50k/mo) | Business ($250/mo annual, 50k/mo) | Enterprise |
| --- | --- | --- | --- | --- |
| Batching | — | — | ✓ | ✓ |
| Digest | — | — | ✓ | ✓ |
| Throttling | — | ✓* | ✓* | ✓* |
| Recipient's timezone | — | ✓ | ✓ | ✓ |
| Branching / Conditions / Multi-step workflows | ✓ | ✓ | ✓ | ✓ |

The pricing table renders checkmarks as images, so only the "—" cells come through as text. Batching and Digest show two dashes, and the Business plan card explicitly adds "Batching & Digest" ("Everything in Essentials, plus: Batching & Digest …"). The cells marked * have a single dash and are read as Free-only exclusions by column order. Treat those as likely, not certain.

- **Trial:** new accounts get a one-month "Sandbox" with all paid features, after which the account "transitions to Free Plan".
- **[unverified]** What happens to a live workflow containing a Batch or Digest node after the trial ends on Free. It could be blocked at publish, skipped, or fail at execution.
- **Billing:** "In case of batching / digest where multiple requests are batched or grouped into one notification (e.g., a digest email), it counts as **one notification** for billing."
- **Other billing rules:**
  - Each channel to which a notification is sent counts separately: email + in-app = 2.
  - Each recipient in a bulk request counts.
  - Notifications SuprSend itself drops (opt-out, inactive channel) are not counted.
  - Vendor-side failures *are* counted.

## 7. Options this opens for Cadence's later decisions

These are facts mapped to choices. They are not recommendations.

### Inline call vs outbox

- The SDK gives an acceptance signal only (`202`). Errors come back as resolved values, not exceptions.
- There is no retry and no timeout. Either path needs its own timeout, for example an `AbortController`-style wrapper or an axios default set globally. The SDK calls the default axios instance (`import axios from "axios"; axios.post(...)`), so a global `axios.defaults.timeout` should apply, provided the app resolves the same axios copy **[untested]**.
- Either path needs its own retry policy.
- An idempotency key derived from the domain record makes retries safe for up to 24 h. Examples are a Purchase id + notification kind, or an outbox row id. A retry after more than 24 h could duplicate.

### Workflow API vs events

- With events, a Notification to a user not yet synced to SuprSend is silently dropped.
- The Workflow API upserts the recipient inline and returns `404` on a bad slug.

### Digesting noisy feed-only Notifications

- **Server-side:** SuprSend Batch or Digest requires the Business plan ($250/mo), above the Essentials upgrade path named in ADR-0013. On Free, Throttle is not available either*.
- **Client-side:** Cadence can do the grouping itself, either before triggering or by aggregating at feed-render time. That needs no paid plan, but every trigger then counts as a billed notification.
- Billing counts a batched or digested send as one notification, so server-side batching also reduces usage against the 10k/50k quota.

## Sources

- SuprSend docs (raw Markdown via `https://docs.suprsend.com/<path>.md`):
  - [Event vs Workflow API](https://docs.suprsend.com/docs/guides/event-vs-workflow-api.md)
  - [Trigger Workflow API](https://docs.suprsend.com/reference/trigger-workflow-api.md)
  - [Trigger an Event](https://docs.suprsend.com/reference/trigger-event.md)
  - [Idempotent Requests](https://docs.suprsend.com/reference/idempotent-requests.md)
  - [Node: trigger workflow](https://docs.suprsend.com/docs/node-trigger-workflow-from-api.md)
  - [Node: send events](https://docs.suprsend.com/docs/node-send-event-data.md)
  - [Request logs](https://docs.suprsend.com/docs/request-logs.md)
  - [Execution Errors](https://docs.suprsend.com/docs/error-guides.md)
  - [Management API errors](https://docs.suprsend.com/docs/management-api-errors.md)
  - [Outbound Webhook](https://docs.suprsend.com/docs/outbound-webhook.md)
  - [Vendor Fallback](https://docs.suprsend.com/docs/vendor-fallback.md)
  - [Webhook node](https://docs.suprsend.com/docs/webhook.md)
  - [Notification Category](https://docs.suprsend.com/docs/notification-category.md)
  - [Batch](https://docs.suprsend.com/docs/batch.md)
  - [Digest](https://docs.suprsend.com/docs/digest.md)
  - [Throttle](https://docs.suprsend.com/docs/throttle.md)
  - [Cancel Workflow API](https://docs.suprsend.com/reference/cancel-workflow.md)
  - [Changelog](https://docs.suprsend.com/changelog/overview.md)
- SDK source: [suprsend/suprsend-node-sdk](https://github.com/suprsend/suprsend-node-sdk) @ `8ac5db0` (v1.15.1)
  - `src/workflow_api.js`
  - `src/workflow_request.js`
  - `src/event.js`
  - `src/workflow_trigger_bulk.js`
  - `src/constants.js`
  - `src/signature.js`
  - `types/index.d.ts`
- [axios request config](https://github.com/axios/axios#request-config) (`timeout` default `0`)
- [SuprSend pricing](https://www.suprsend.com/pricing): plan table and FAQ, fetched 2026-11-17
