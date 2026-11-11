# Keep a learner's progress when their Refund Request is Approved

When a Refund Request is Approved the learner loses access to the course, but we keep everything they did in it — lesson progress, video watch history, quiz attempts. We want refunded learners to come back: if they buy the course again, they pick up exactly where they left off instead of starting over. Keeping the history also means the refund limits (watch time and lessons completed) count across repeat purchases, so buy–watch–refund–rebuy cannot reset them.

## Consequences

- Progress records can exist for a course the learner no longer has access to. That is deliberate, not orphaned data — do not clean it up.
- Anything that reads progress (dashboards, analytics, completion counts) must check access, not just the existence of progress.
