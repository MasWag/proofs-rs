ALTER TABLE zulip_deliveries ADD COLUMN alert_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE zulip_deliveries ADD COLUMN alert_sent_at TEXT;
ALTER TABLE zulip_deliveries ADD COLUMN alert_lease_until TEXT;
ALTER TABLE zulip_deliveries ADD COLUMN alert_token TEXT;
ALTER TABLE zulip_deliveries ADD COLUMN alert_next_attempt_at TEXT;
ALTER TABLE zulip_deliveries ADD COLUMN alert_error TEXT;
