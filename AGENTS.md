## Verification checks

Do these checks in this order before you report a change to `app/` as complete:

1. `npm run typecheck`
2. `npm run test`

## When something breaks

| Symptom                                         | Cause                                                                                                  |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 401 "Select a user from the DevUI panel"        | No user in the session — switch users and country in the floating panel (`app/components/dev-ui.tsx`). |
| `tsc` reports every `./+types/*` import missing | Typegen has not run. Use `npm run typecheck`, which runs `react-router typegen` first.                 |
| After `npm run db:seed`, a Notification never arrives, or a SuprSend Staging feed shows old items | Expected. Ids repeat after a reseed, so idempotency keys repeat: SuprSend drops a trigger whose key it saw in the last 24 hours, and Staging feeds keep items from earlier seeds. |
| A web push never arrives (SuprSend's log: "Computing channels to notify on: Inbox"), or arrives for the previous DevUI user | The DevUI switch moves this browser's push between users, and can leave it attached to the previous one; logout detaches it correctly. Test push with the recipient signed in on their own window and the actor in a private window. |

## Agent skills

### Issue tracker

Issues and PRDs live as GitHub issues on your own copy of this repo (the `origin` remote), never on `ai-hero-dev/cohort-005-project`, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.
