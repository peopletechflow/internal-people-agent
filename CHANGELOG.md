# Changelog

## 0.2.0 (2026-11-08)
- Live mode: upstream Workday MCP client (official SDK, Streamable HTTP), capability mapping with tools/list verification and strict response validation, identity from upstream.
- Postgres store with versioned migrations: bound single-use previews, durable idempotent commits with pending, succeeded, failed and unknown outcomes, reconcile tools, consents, audit.
- Auditable decision chain; optional TypeSafe Jev intent classifier.
- Renamed to Internal People Agent | Workday MCP.

## 0.1.0 (2026-11-08)
- First release, fixture only, extracted from workday-mcp-schema at 4bf10b2.

## Unreleased: native benefits instruction
- Versioned the Workday native benefits skill at `native/ipa-benefits-skill/SKILL.md`, separate from the external MCP skill. Tools and WIDs are unchanged. No live mapping was added.

## Unreleased: Workday Agent Gateway alignment
- Added Agent Gateway mode: ASU OAuth 2.1 + PKCE, paginated discovery with list_changed and TTL refresh and drift fail-closed, an approved tool policy, and the `workday_*` agent tools. Writes are re-checked for contract drift at commit. Fixed capability mappings are off on Agent Gateway endpoints. Production refuses fixtures, example config and fixed bearer tokens.
