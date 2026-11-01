// Pure configuration: run before provisioning any Cloudflare resources.
export function configureDeployment(config, target, env) {
  const customDomain =
    target === "production" && env.PRODUCTION_CUSTOM_DOMAIN !== "false";
  if (customDomain && (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET))
    throw Error(
      "Configure production GitHub OAuth for https://proofs.rs/auth/github/callback before domain activation.",
    );
  if (
    env.PRODUCTION_EMAIL_ENABLED &&
    !["true", "false"].includes(env.PRODUCTION_EMAIL_ENABLED)
  )
    throw Error("PRODUCTION_EMAIL_ENABLED must be true or false.");
  if (
    env.PRODUCTION_ZULIP_ENABLED &&
    !["true", "false"].includes(env.PRODUCTION_ZULIP_ENABLED)
  )
    throw Error("PRODUCTION_ZULIP_ENABLED must be true or false.");
  const zulipEnabled =
    target === "production" && env.PRODUCTION_ZULIP_ENABLED === "true";
  config.vars.ZULIP_ENABLED = zulipEnabled ? "true" : "false";
  for (const key of ["ZULIP_SITE", "ZULIP_CHANNEL_ID", "ZULIP_BOT_EMAIL"]) {
    delete config.vars[key];
    if (zulipEnabled) {
      if (!env[key]?.trim()) throw Error("Missing " + key);
      config.vars[key] = env[key].trim();
    }
  }
  if (zulipEnabled) {
    const site = new URL(config.vars.ZULIP_SITE);
    if (
      site.protocol !== "https:" ||
      site.username ||
      site.password ||
      site.pathname !== "/" ||
      site.search ||
      site.hash
    )
      throw Error("ZULIP_SITE must be an HTTPS origin.");
    if (!/^[1-9]\d*$/.test(config.vars.ZULIP_CHANNEL_ID))
      throw Error("Invalid ZULIP_CHANNEL_ID.");
    if (!env.ZULIP_API_KEY?.trim()) throw Error("Missing ZULIP_API_KEY.");
    let webhook;
    try {
      webhook = new URL(env.DISCORD_WEBHOOK_URL || "");
    } catch {
      throw Error("Configure DISCORD_WEBHOOK_URL for Zulip failure alerts.");
    }
    if (
      webhook.origin !== "https://discord.com" ||
      webhook.username ||
      webhook.password ||
      !/^\/api\/webhooks\/\d+\/[\w-]+$/.test(webhook.pathname) ||
      webhook.search ||
      webhook.hash
    )
      throw Error("Configure DISCORD_WEBHOOK_URL for Zulip failure alerts.");
  }
  config.workers_dev = !customDomain;
  if (target === "production") config.preview_urls = false;
  const emailEnabled =
    target === "production" && env.PRODUCTION_EMAIL_ENABLED === "true";
  config.vars.EMAIL_DISABLED = emailEnabled ? "false" : "true";
  delete config.send_email;
  if (emailEnabled) {
    if (!customDomain)
      throw Error("Production email requires the proofs.rs custom domain.");
    if (!env.EMAIL_EVENT_SUBSCRIPTION?.trim())
      throw Error(
        "Configure the proofs.rs Email Sending event subscription and set PRODUCTION_EMAIL_EVENT_SUBSCRIPTION before enabling email.",
      );
    config.vars.EMAIL_FROM = "notifications@proofs.rs";
    config.vars.EMAIL_DOMAIN = "proofs.rs";
    config.vars.EMAIL_EVENT_SUBSCRIPTION = env.EMAIL_EVENT_SUBSCRIPTION.trim();
    // Do not set an empty destination allowlist: production notifies opted-in users.
    config.send_email = [
      { name: "EMAIL", allowed_sender_addresses: [config.vars.EMAIL_FROM] },
    ];
  }
  return customDomain;
}
