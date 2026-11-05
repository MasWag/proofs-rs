# proofs.rs

- [Website](https://proofs.rs)
- [Book](https://proofs.rs/book/)
- [Zulip](https://proofs-rs.zulipchat.com/)
- [CLI](cli/README.md)
- [Development](docs/development.md)
- [Announcement](https://proofs-rs.hashnode.dev/announcing-proofs-rs-a-public-registry-for-rust-formal-verification-results)
- [Zulip announcements setup](docs/zulip-notifications.md)

This repository contains the source for [proofs.rs](https://proofs.rs), a public registry for Rust formal verification results. It includes the website and service, the `cargo proofs` publishing CLI, and the proofs.rs book.

A Report records an author's verification results for one version of a crate, with Claims about individual APIs, assumptions, limitations, evidence, and discussion. Publication is not certification: proofs.rs does not independently rerun verification. Authors can publish independently of the upstream project, and small, well-scoped results are welcome.

The service runs on Cloudflare Workers with Hono and TypeScript. The [development guide](docs/development.md) covers local setup, tests, and deployment; its [local UI demo](docs/development.md#local-ui-demo) provides seeded scenarios for working on the interface. The CLI lives in `cli/`, and the book source lives in `book/`.

Authenticated API writes have daily quotas, reset at midnight UTC. Report creation
and revisions share 200 requests per account; verification runs allow 900, findings
1,000, finding links 2,000, and comments 1,000. New crate imports allow 50 per
account and 500 per IP. Exceeding a quota returns HTTP 429 (`daily_limit`). Updated
quota values apply on the next request, preserving that day's usage. Authentication
and device authorization have separate limits.
