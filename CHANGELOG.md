# Changelog

## 0.2.0 (2026-11-08)
- Live mode: upstream Workday MCP client (official SDK, Streamable HTTP), capability mapping with tools/list verification and strict response validation, identity from upstream.
- Postgres store with versioned migrations: bound single-use previews, durable idempotent commits with pending, succeeded, failed and unknown outcomes, reconcile tools, consents, audit.
- Auditable decision chain; optional TypeSafe Jev intent classifier.
- Renamed to Internal People Agent | Workday MCP.

## 0.1.0 (2026-11-08)
- First release, fixture only, extracted from workday-mcp-schema at 4bf10b2.
