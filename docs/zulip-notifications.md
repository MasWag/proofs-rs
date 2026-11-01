# Zulip announcements

Production can announce new reports, revisions and comments in one Zulip channel,
using the stable topic `Report #<id>`. Messages contain English metadata and links;
report and comment bodies are not copied. Email preferences do not affect these
announcements. Events are recorded only while production Zulip is enabled; there
is no historical backfill. Disable the integration to cancel pending announcements.

Create a generic Zulip bot and subscribe it to the destination channel. Set these
GitHub production environment variables:

- `PRODUCTION_ZULIP_ENABLED=true` (defaults to disabled)
- `PRODUCTION_ZULIP_SITE=https://your-organization.zulipchat.com`
- `PRODUCTION_ZULIP_CHANNEL_ID` to the numeric destination channel ID
- `PRODUCTION_ZULIP_BOT_EMAIL` to the bot's API email address

Store the bot API key in the production environment secret
`PRODUCTION_ZULIP_API_KEY`. The production workflow validates configuration and
installs it as the Worker secret `ZULIP_API_KEY`. Never put the key in Wrangler
vars or source control. Staging and local environments never send announcements.

The existing queue dispatch runs after publication and every five minutes. A
15-second request timeout and 60-second delivery lease prevent overlapping sends.
Transient failures retry with exponential backoff, respecting Retry-After, up to
eight attempts. Authentication and other permanent HTTP errors fail immediately.
Delivery after an ambiguous response may produce duplicate Zulip messages.

Inspect `zulip_deliveries` joined to `outbox_events` by `event_id` for status,
attempts, `last_error` and `message_id`. Logs contain only event IDs, attempt
counts and sanitized outcome codes. After correcting a failed integration, retry
one selected event using a D1 transaction/batch with these parameterized SQL
statements (replace `?` with the same event ID):

```sql
UPDATE zulip_deliveries
SET status='pending', attempts=0, next_attempt_at=NULL,
    lease_until=NULL, attempt_token=NULL, last_error=NULL
WHERE event_id=? AND status='failed';
UPDATE outbox_events SET completed_at=NULL, enqueued_at=NULL
WHERE id=? AND EXISTS (
  SELECT 1 FROM zulip_deliveries d
  WHERE d.event_id=outbox_events.id AND d.status='pending'
);
```

Only retry after inspecting the target topic for an already-delivered message.
The next scheduled dispatch will enqueue the event. Hidden reports and deleted
or hidden comments are cancelled at send time. Existing sent messages are not
removed when content is subsequently hidden or deleted.

## Failure alerts on Discord

When a Zulip delivery reaches `failed` (a permanent error, eight attempts, or an
expired final delivery lease), the same D1 transaction records a separate
`zulip_failure` outbox event. The queue is notified immediately; the existing
outbox dispatcher recovers failed enqueue attempts. Transient Zulip failures that
are still being retried do not trigger a failure alert, but are checked once at
15 minutes as described below. Cancelled deliveries never trigger alerts.

Production reuses the GitHub `DISCORD_WEBHOOK_URL` secret used by deployment
notifications. The workflow installs it as Worker secret
`ZULIP_FAILURE_WEBHOOK_URL`. Enabling production Zulip now requires this webhook,
validated before provisioning. It must be an HTTPS `discord.com/api/webhooks/...`
URL without a query or fragment. Staging never sends these alerts.

Alerts include the source event ID, report link, revision (for report events),
attempt count and sanitized error code. They omit report/comment bodies, bot
credentials and webhook URLs; Discord mentions are disabled. Alerts still send
if Zulip is subsequently disabled. A retry or recovery of the source delivery
before the alert is processed cancels the obsolete alert when it no longer
meets the alert condition (a failure alert requires `failed`; a delayed alert
requires an unsent, non-cancelled delivery).

Each source event has one durable alert. Alert delivery uses its own lease and
retry state, independently of the original failed Zulip delivery. Discord 429,
5xx, network and malformed-success responses retry with exponential backoff and
respect `Retry-After`, up to eight attempts. Redirects are never followed. The
existing dispatcher recovers pending alert events; retry timing can be later
than the minimum backoff. An ambiguous response or crash after Discord accepts a
message can still cause a duplicate.

Inspect `alert_attempts`, `alert_sent_at`, `alert_error`, `alert_lease_until` and
`alert_next_attempt_at` on `zulip_deliveries`, alongside the `zulip_failure`
outbox event. Alert delivery failures produce sanitized `zulip_alert_retry` or
`zulip_alert_failed` error logs. Already-completed historical failures are not
backfilled by this migration.

## One delayed check after 15 minutes

Each new Zulip event creates a `zulip_check` outbox event in the same publication
transaction. Its deadline is the source event creation time plus 15 minutes.
The dispatcher submits it with Cloudflare Queues `delaySeconds` set to the
remaining time (initially 900 seconds). An already-scheduled check is not
resubmitted by the five-minute dispatcher while waiting for its deadline.

At the deadline, the queue consumer checks the delivery once. A pending,
retrying or sending delivery, including an event whose delivery never started,
creates a Discord alert headed `Zulip delivery still unsent after 15 minutes`.
A failed delivery uses the existing failure alert. Both conditions share one
alert per source event, so a delayed alert followed by permanent failure does
not produce another notification. The original Zulip delivery keeps its own
retry schedule and may still succeed later.

Sent/cancelled deliveries, hidden reports, deleted/hidden comments and disabled
Zulip integrations are skipped. If delivery succeeds before the Discord alert
is sent, the obsolete alert is cancelled. The check does not repeatedly inspect
an unsent event every five minutes. Queue delivery can occur later than its
deadline; early delivery is retried for the remaining delay. The durable outbox
recovers failed enqueue attempts, and can redrive an overdue uncompleted check
after the normal ten-minute recovery grace period. Duplicate queue deliveries
are harmless after the check completes. Historical events are not backfilled.
