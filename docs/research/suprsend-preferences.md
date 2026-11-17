# SuprSend notification preferences

Accessed: 2026-11-17. Sources are SuprSend's own docs (docs.suprsend.com), its pricing page and its SDK source on GitHub. **[unverified]** marks claims I could not confirm on a primary page. **[inference]** marks my reading of what the sources imply.

## Question

What does SuprSend offer for Notification preferences? Specifically: categories and how workflows map to them, opting out per category and per channel, marking a category as mandatory (no opt-out), the headless preference API/hooks for building our own settings UI, the hosted preference page and unsubscribe link for email (`$hosted_preference_url`), and how an opted-out send is handled and billed.

## Summary

- **Preferences are not on the Free plan.** The pricing page's comparison table marks Channel Preferences, Categories & Sub-category preferences, Ready UI for Preference Center and Hosted Preference Page as "—" for Free and Essentials, and ticked for Business ($250/mo billed annually) and Enterprise. The Business card lists "User Preferences" as a Business addition [P1]. New accounts get every feature for a 30-day trial, then drop to Free [P1]. The docs themselves never mention this gating. What actually happens to categories, preference APIs and stored opt-outs on a Free workspace after the trial is **[unverified]**.
- **One category per workflow.** Each workflow maps to one root-category (System, Transactional, Promotional) or one sub-category. User preferences apply **only to sub-categories**. A workflow sent directly in a root-category ignores preferences entirely [D1][D2].
- **Three levels of opt-out:** global per channel (`All` / `Required`), per sub-category, and per channel within a sub-category [D2][D5].
- **Mandatory = "Can't Unsubscribe"** on a sub-category, with chosen mandatory channels. The user can't turn the category off or opt out of its mandatory channels, but can still drop its non-mandatory channels [D2][D3].
- **No dedicated preference hooks in React.** `@suprsend/react` gives you `useSuprSendClient()`. Its `client.user.preferences.*` methods return plain JSON you render with your own components, so no SuprSend UI is needed [D5][D6][G1][G2].
- **Hosted page:** `{{$hosted_preference_url}}` links to a page SuprSend generates on its own domain. When the link is in an email, the page shows and saves email preferences [D2]. It is a paid-plan feature [P1].
- **An opted-out send is skipped and not billed.** A category opt-out stops the workflow at trigger time. A channel opt-out is checked at each delivery node. Pricing FAQ: sends that SuprSend drops for "user opt-out or inactive channels" are not counted toward billing [D4][P1].

## Categories and how workflows map to them

- **Hierarchy: root-category → section → sub-category** [D1].
  - **Root-categories** are fixed: System, Transactional, Promotional. They pick the queue and, for email/SMS, the vendor. "Preferences are not applied at the root-category level." Users never see them [D1].
  - **Sections** are optional UI groupings on the preference page. They hold no preference [D1].
  - **Sub-categories** are "what users see on preference / unsubscription page and can opt in/out of" [D1].
- **Mapping:** "Each workflow can either map to a root-category … or a sub-category." In the dashboard you pick the category from the **Preference Category** dropdown on a delivery node. For a dynamic (code-defined) workflow you pass `notification_category: "<sub-category slug>"` in the trigger. The CLI and Management API can also set it [D1][D3].
- Users can't unsubscribe from a root-category. The docs warn that a workflow sent with a root-category slug such as `"promotional"` can't be unsubscribed from via the preference centre [D2].
- **Changes need a publish.** Category changes are version-controlled and only go live after **Publish Changes**. A category doesn't appear in workflow dropdowns until it is published. Renaming a sub-category changes its slug and "can break existing workflows" [D3].
- Categories can be managed as code with `suprsend category pull/push/commit` (CLI) or the Create/Update Category API. That API "replaces all categories" [D3].
- **Extras per sub-category:** a user-selectable digest schedule, condition properties usable in workflow branches, and tags for filtering the UI. Category translations are Enterprise or feature-flag only [D1].

## Opting out per category and per channel

A user's preference set has three parts [D2]:

```json
{
  "channel_preferences": [{ "channel": "email", "is_restricted": true }],
  "categories": [
    { "category": "invoice-ready", "preference": "opt_out" },
    { "category": "payment-reminder", "preference": "opt_in", "opt_out_channels": ["slack"] }
  ]
}
```

1. **Global per channel** (`channel_preferences[].is_restricted`): `false` = **All** (everything except categories the user turned off); `true` = **Required** (only categories where this channel is mandatory) [D5][D7].
2. **Per sub-category** (`preference: opt_in | opt_out`) [D2].
3. **Per channel inside a sub-category** (`opt_out_channels`) [D2].

- **Channel identifiers** accepted by the preference APIs include `email`, `inbox`, `webpush`, `sms`, `whatsapp`, `androidpush`, `iospush`, `slack` and `ms_teams` [D8].
- **Inbox (in-app) is behind a feature flag.** "The inbox channel preference is behind a feature flag and needs to be enabled for your account." You have to ask support@suprsend.com to turn it on. Without it, `inbox` doesn't appear in user preferences [D2]. This matters because the Notification Feed is one of Cadence's three channels.
- **Defaults per sub-category:** **On** (opted in, can opt out, optionally only on selected channels), **Off** (must opt in) or **Can't Unsubscribe** [D2][D3].
- **Precedence:** user choice → tenant default → category default. Precedence is resolved per category, so untouched categories keep following the default. Once a user overrides a category, later changes to its default no longer reach them [D2][D4].
- Channel-level opt-outs that come from outside (email unsubscribe, SMS STOP, mobile OS push opt-out) "override all category and tenant preferences" [D4]. The docs don't say whether a browser revoking web-push permission counts the same way **[unverified]**.
- User preferences are **not** in the workflow payload, so a branch can't read them [D2].

## Marking a category mandatory

- Set the sub-category's default to **Can't Unsubscribe**, then choose **Mandatory Channels** ("All" or "Selected Channels"). With "Selected", you also pick which other channels start opted in [D2].
- **Effect:** the category toggle comes back as `is_editable: false`, and so does each mandatory channel inside it. "Users can still opt out of specific channels, but at least one mandatory channel must remain active." [D3][D5]
- A user on **Required** for a channel still gets that channel for categories where it is mandatory [D5][D7].
- **Docs' recommended defaults:** System and Transactional → Can't Unsubscribe; Promotional → On. New transactional sub-categories default to Can't Unsubscribe [D3].
- **Interaction with email unsubscribe:** a Can't Unsubscribe sub-category can't be marked **Is commercial**, so its emails carry no one-click `List-Unsubscribe` headers [D3].
- **The alternative is to send in a root-category.** A workflow sent directly in a root-category (e.g. `system` or `transactional`) bypasses preferences entirely and never appears on the preference page [D1][D2]. The SuprSend docs describe System as "Essential notifications that users can't unsubscribe from" [D1].
- **Where enforcement lives:** the web SDK refuses to change a category whose `is_editable` is false. It returns "Category preference is not editable" without calling the API [G2]. Whether the REST API also rejects a server-side opt-out of a Can't Unsubscribe category is **[unverified]**.

## Headless API and hooks for our own settings UI

- **Packages:** `@suprsend/react` (npm 1.5.0) re-exports `@suprsend/react-core` and adds feed components [G1]. Its only hooks are `useSuprSendClient`, `useAuthenticateUser`, the feed hooks (`useFeed`, `useFeedClient`, `useFeedData`) and `useTranslations`. There are **no preference-specific hooks** [G1][G3].
- **How to use it:** `useSuprSendClient()` returns a `@suprsend/web-sdk` client (npm 5.4.0) whose `user.preferences` object does the work [D6][G2]:

| Method | Purpose |
| --- | --- |
| `getPreferences({ tenantId?, tags?, locale? })` | Load full preference data. Must be called first. |
| `updateCategoryPreference(category, opt_in \| opt_out)` | Toggle a sub-category |
| `updateChannelPreferenceInCategory(channel, opt_in \| opt_out, category)` | Toggle one channel within a sub-category |
| `updateOverallChannelPreference(channel, all \| required)` | Global per-channel setting |
| `updateDigestScheduleInCategory`, `updatePropertiesInCategory` | Digest cadence / condition properties |
| also `getCategories`, `getCategory`, `getOverallChannelPreferences` | Partial reads |

- **Shape of the data:** `{ sections: [{ name, description, subcategories: [{ name, category, description, preference, is_editable, channels: [{ channel, preference, is_editable }] }] }], channel_preferences: [{ channel, is_restricted }] }`. Your UI disables controls where `is_editable` is false [D5].
- **Updates are optimistic.** The API call goes out in the background after a 1-second debounce. Results arrive on `client.emitter` as `preferences_updated` / `preferences_error` [D5][G2].
- **Auth:** the SDK calls `/v1/user/{distinct_id}/preference/…` as the signed-in user [G2]. The same endpoints are on the REST API with the workspace API key, for server-side use [D7][D8].
- **Page discovery is by link, not by component.** The "embedded preference centre" is just your own page built on these methods. You register its URL in tenant settings and link to it from templates with `{{$embedded_preference_url}}` [D9].
- The older `@suprsend/react-preferences-headless` package is marked deprecated [D10].

## Hosted preference page and email unsubscribe

- **Hosted page:** after you publish categories, "SuprSend automatically generates a dedicated unsubscription webpage". Templates link to it with `{{$hosted_preference_url}}`. "If the link is included in an email, the hosted page will show and save email preferences." [D2]
  - It lives on a SuprSend domain. Hosting it on your own domain means contacting support [D2].
  - It picks up locale from the user profile [D2].
  - The pricing tooltip calls it "a white-labeled preferences web page hosted by SuprSend" [P1].
- **One-click unsubscribe:** SuprSend adds `List-Unsubscribe` and `List-Unsubscribe-Post` headers only to emails sent in a sub-category marked **Is commercial** [D2][D3].
  - Promotional sub-categories are commercial by default. Transactional ones are not, System ones never are, and Can't Unsubscribe ones can't be [D3].
  - A click opts the user out of **email for that one sub-category** only. The link works for 90 days [D2].
  - Mail clients decide whether to show the button, and do so mainly for established bulk senders [D2].

## How an opted-out send is handled and billed

- **Category opt-out:** checked **at trigger time**. "If a user has opted out of the preference category linked to the workflow, the workflow is not executed for that user." The execution log records the run as skipped for that reason [D4].
  - **Exception:** if the workflow has a webhook node or a data-update node (update profile, list or object subscription), the check moves to the delivery node so those side effects still run [D4].
  - Test triggers from the dashboard also check at the delivery node [D4].
- **Channel opt-out:** checked at each delivery node. The step debugger's "Preference Evaluation" panel shows what blocked or allowed each send [D4].
- **Billing:** "Notifications that are failed by SuprSend due to reasons like user opt-out or inactive channels, etc, they are not counted towards billing." Each channel delivered to each user counts as one notification, and a digest counts as one [P1].
- **Overage on Free:** going over the 10k/mo Free limit doesn't stop sending. SuprSend contacts you to upgrade [P1].

## Unverified / open

- Behaviour on a Free workspace after the 30-day trial. Do category assignments and stored preferences keep being enforced, get ignored, or do the preference APIs refuse? Only the pricing table speaks to this [P1]. Ask SuprSend support or test in a post-trial workspace.
- Whether the inbox-channel feature flag is available on Free.
- Whether the REST API (server-side, API key) rejects an opt-out of a Can't Unsubscribe category, or only the SDK guards it.
- Whether revoking browser web-push permission is treated as a channel opt-out.
- The default category of a workflow when none is chosen.

## Sources

- [D1] Preference categories overview: https://docs.suprsend.com/docs/notification-category
- [D2] User Preferences: https://docs.suprsend.com/docs/user-preferences
- [D3] Manage Categories and Preferences: https://docs.suprsend.com/docs/managing-notification-categories
- [D4] Preference Evaluation: https://docs.suprsend.com/docs/preference-evaluation
- [D5] JavaScript preferences (web SDK): https://docs.suprsend.com/docs/js-preferences
- [D6] React preferences: https://docs.suprsend.com/docs/preference-react-sdk
- [D7] Designing Notification Preferences guide: https://docs.suprsend.com/docs/guides/preference-guide
- [D8] API reference, update channel / category preference: https://docs.suprsend.com/reference/update-user-channel-preference, https://docs.suprsend.com/reference/update-user-category-preference
- [D9] Embedded Preference Centre: https://docs.suprsend.com/docs/embedded-preference-centre
- [D10] React (legacy headless) preferences: https://docs.suprsend.com/docs/preferences-react-headless
- [P1] Pricing page (plan cards, comparison table, billing FAQ): https://www.suprsend.com/pricing
- [G1] `@suprsend/react` source, `src/index.ts`: https://github.com/suprsend/suprsend-react-sdk
- [G2] `@suprsend/web-sdk` source, `src/preferences.ts`: https://github.com/suprsend/suprsend-web-sdk/blob/main/src/preferences.ts
- [G3] `@suprsend/react-core` source, `src/core/hooks`: https://github.com/suprsend/suprsend-react-core
