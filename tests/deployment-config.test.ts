import { test } from "node:test";
import assert from "node:assert/strict";
import { configureDeployment } from "../scripts/deployment-config.mjs";
const oauth = { GITHUB_CLIENT_ID: "test", GITHUB_CLIENT_SECRET: "test" };
test("production domain and email configuration fails closed; staging never sends", () => {
  const config =
    (): import("../scripts/deployment-config.mjs").DeploymentConfig => ({
      vars: {},
      send_email: [{ name: "STALE" }],
    });
  let c = config();
  assert.equal(configureDeployment(c, "production", oauth), true);
  assert.equal(c.workers_dev, false);
  assert.equal(c.preview_urls, false);
  assert.equal(c.vars.EMAIL_DISABLED, "true");
  assert.equal(c.send_email, undefined);
  assert.throws(() => configureDeployment(config(), "production", {}), /OAuth/);
  assert.throws(
    () =>
      configureDeployment(config(), "production", {
        ...oauth,
        PRODUCTION_EMAIL_ENABLED: "true",
      }),
    /subscription/,
  );
  assert.throws(
    () =>
      configureDeployment(config(), "production", {
        ...oauth,
        PRODUCTION_EMAIL_ENABLED: "true",
        PRODUCTION_CUSTOM_DOMAIN: "false",
      }),
    /custom domain/,
  );
  c = config();
  configureDeployment(c, "production", {
    ...oauth,
    PRODUCTION_EMAIL_ENABLED: "true",
    EMAIL_EVENT_SUBSCRIPTION: "test-subscription",
  });
  assert.equal(c.vars.EMAIL_DISABLED, "false");
  assert.equal(c.vars.EMAIL_DOMAIN, "proofs.rs");
  assert.equal(c.vars.EMAIL_EVENT_SUBSCRIPTION, "test-subscription");
  assert.deepEqual(c.send_email, [
    { name: "EMAIL", allowed_sender_addresses: ["notifications@proofs.rs"] },
  ]);
  c = config();
  assert.equal(
    configureDeployment(c, "staging", { PRODUCTION_EMAIL_ENABLED: "true" }),
    false,
  );
  assert.equal(c.vars.EMAIL_DISABLED, "true");
  assert.equal(c.send_email, undefined);
});

test("only staging and an explicit pre-domain production fallback use workers.dev", () => {
  for (const target of ["staging", "production"]) {
    const c = { vars: {}, workers_dev: false, preview_urls: false };
    assert.equal(
      configureDeployment(c, target, { PRODUCTION_CUSTOM_DOMAIN: "false" }),
      false,
    );
    assert.equal(c.workers_dev, true);
    assert.equal(c.preview_urls, false);
  }
});

test("Zulip deployment is opt-in and production-only", () => {
  const env = {
    PRODUCTION_CUSTOM_DOMAIN: "false",
    PRODUCTION_ZULIP_ENABLED: "true",
    ZULIP_SITE: "https://zulip.example",
    ZULIP_CHANNEL_ID: "12",
    ZULIP_BOT_EMAIL: "bot@example.test",
    ZULIP_API_KEY: "key",
    DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/test-token",
  };
  const c = { vars: {} as Record<string, string> };
  configureDeployment(c, "staging", env);
  assert.equal(c.vars.ZULIP_ENABLED, "false");
  configureDeployment(c, "production", env);
  assert.equal(c.vars.ZULIP_ENABLED, "true");
  assert.equal(c.vars.ZULIP_API_KEY, undefined);
  assert.equal(c.vars.DISCORD_WEBHOOK_URL, undefined);
  assert.equal(c.vars.ZULIP_FAILURE_WEBHOOK_URL, undefined);
  for (const webhook of [
    "",
    "invalid-secret",
    "https://other.example/api/webhooks/123/secret",
    "https://user:secret@discord.com/api/webhooks/123/token",
  ]) {
    assert.throws(
      () =>
        configureDeployment(c, "production", {
          ...env,
          DISCORD_WEBHOOK_URL: webhook,
        }),
      /^Error: Configure DISCORD_WEBHOOK_URL for Zulip failure alerts\.$/,
    );
  }

  assert.throws(() =>
    configureDeployment(c, "production", { ...env, DISCORD_WEBHOOK_URL: "" }),
  );
  assert.throws(() =>
    configureDeployment(c, "production", { ...env, ZULIP_API_KEY: "" }),
  );
  assert.throws(() =>
    configureDeployment(c, "production", {
      ...env,
      ZULIP_SITE: "http://zulip.example",
    }),
  );
});
