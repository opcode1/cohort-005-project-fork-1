# SuprSend delivers Notifications

Cadence sends every Notification through SuprSend, a hosted provider, on its free tier. The provider comparison had recommended Novu Cloud, mainly because Novu offers EU data residency on every plan. That advantage stopped mattering once we established that Cadence's users are mainly in the US. For them, GDPR means a data processing agreement and deletion on request, not EU hosting. SuprSend's built-in web push then worked end to end in the Notification Feed prototype without adding FCM or OneSignal.

## Consequences

- **SuprSend is called in only two places, to keep switching cheap.** On the server, every Notification goes through one notify module, and actions never call SuprSend directly. In the browser, the Notification Feed is drawn with our own components on top of SuprSend's headless hooks. This also avoids the free tier's Inbox branding.
- **Free tier while Cadence is in early development.** Upgrade to Essentials ($100/mo, billed annually) when monthly volume gets close to the 10k free limit, or when we need something only a paid plan offers.
- **The DPA comes first.** No real user data is sent to SuprSend's Production workspace until its data processing agreement is signed.
