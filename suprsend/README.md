# SuprSend templates and workflows

One template and one workflow per Notification in `app/lib/notification-catalogue.ts`, in the layout the [SuprSend CLI](https://docs.suprsend.com/reference/cli-intro) reads. Each template's Inbox variant is tagged with its workflow slug; the browser reads that tag to tell which Notification a feed item is.

Push templates before workflows, because a workflow can only use a committed template. Set `SUPRSEND_SERVICE_TOKEN` first; it comes from Account Settings → Service Tokens.

```sh
suprsend -w staging template push -d ./suprsend/templates --commit -F
suprsend -w staging workflow push -d ./suprsend/workflows --commit -F
```

Use `-w production` for Production. Run the commands in a real terminal: without one, `push` exits 0 and sends nothing.
