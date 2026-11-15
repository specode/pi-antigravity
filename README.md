# pi-antigravity

[English](./README.md) | [简体中文](./README.zh-CN.md)

An independently maintained Antigravity subscription provider for Pi. It adapts the official **agy CLI HTTP protocol** without running the CLI, an ACP bridge, or another agent.

**Status: public-source chat provider, installed and user-tested locally.** Tested against Pi **1.5.2** with synthetic HTTP responses and bounded live diagnostics; see the acceptance limits below.

## Installation

Requires Node.js >= 22.19.0 and the Pi 1.5.2 provider APIs used by this implementation. Use version 0.1.1 or later for clean npm installations; 0.1.0 could rely on development dependencies to resolve Pi subpath imports.

From npm:

```sh
pi install npm:@specode/pi-antigravity
```

Or from GitHub:

```sh
pi install git:github.com/specode/pi-antigravity
```

If the older `pi-antigravity` package is installed, remove it first with `pi remove npm:pi-antigravity`. Never load two implementations of the `antigravity` provider together. Existing Pi OAuth credentials are retained; no CLI credential migration is required.

Run `/reload` or restart Pi after installation. If needed, use `/login`, choose Antigravity, and paste the complete callback URL when prompted. Select a chat model with `/model`.

For local development:

```sh
pi install /path/to/pi-antigravity
```

## Development

```sh
npm ci
npm run check
```

`check` runs strict type checking, offline tests, an isolated packed-extension smoke test, and a package dry run. The smoke test packs and extracts the package outside the checkout, without the extension's development dependencies, then loads it in real Pi with synthetic credentials and network fetches blocked. It does not touch your installed extensions or credentials. After publication, `npm run smoke -- @specode/pi-antigravity@<version>` validates the registry artifact the same way.

The extension entry is `src/index.ts`. Do not load it alongside another provider registered as `antigravity`. Switching your installed provider, live account testing, and publishing are separate steps—not performed by development tests.

## Publishing

The scoped npm package is public. GitHub Actions validates pushes and pull requests. npm Trusted Publishing is configured for `specode/pi-antigravity` and `npm-publish.yml`, allowing future GitHub Release publications through OIDC without a long-lived npm token. Version 0.1.0 was bootstrapped through maintainer authentication; releases must use a new package version, never republish an existing one. Publishing and creating releases are external operations and require explicit authorization.

## Request flow

1. **Authentication:** native Pi OAuth registration, Google manual callback-URL login with PKCE/state validation, and token refresh. Pi owns credential storage and refresh locking. Existing OAuth credentials retain `access`, `refresh`, `expires`, `projectId`, and optional `email`.
2. **Discovery:** initialize the consumer account and fetch the curated chat catalog. Public model IDs are separate from runtime IDs and explicitly discovered effort variants. Pi's standard model store retains the last successful account-owned snapshot for offline startup; failed refreshes do not erase it.
3. **Conversion:** reuse Pi's public Google converters and normalized transcript. Rewrite only Pi's exact known opening sentences in the serialized system prompt; preserve rules, tools, user text, and session history.
4. **Streaming:** one HTTP attempt to an approved official HTTPS origin, incremental SSE parsing, Pi instrumentation hooks, signatures, tool calls, usage, cancellation, separate header/idle deadlines, and one terminal event. No internal retries or hidden endpoint/model failover.

The default endpoint is `https://daily-cloudcode-pa.googleapis.com`, observed for the consumer account in the handoff. This is not a universal enterprise-routing claim. CLI identity is pinned to **1.5.9 / build 1021519450**, with the actual host platform and architecture.

## Boundaries

- Chat/coding provider only. Antigravity image generation/editing has been cancelled and is not a remaining implementation or testing task.
- Only curated chat models and explicit supported thinking variants are exposed. Unknown thinking contracts are omitted rather than guessed; unsupported requested effort fails visibly.
- Subscription per-token billing is not known. Pi's zero cost metadata means **unpriced**, not free usage or an invoice estimate. Token usage is recorded separately from subscription quota.
- Tool schema names and literal values remain unchanged. Unsupported references or required strict-sampling contracts fail instead of silently removing tools.
- Request UUIDs and transcript counters are provider-local bookkeeping, not a claimed reconstruction of every CLI retry/resume rule. Pi session IDs keep ordinary resumes stable and forks separate; direct calls without a session ID are ephemeral.
- No account switching, credit overage, background warming, quota UI, search/fetch tools, CLI storage migration, or private Pi runtime imports.

## Companion plugins

- **[pi-subscription-usage](https://github.com/specode/pi-subscription-usage):** owns quota queries and display. The JSON credential bridge retains `token`, `projectId`, and optional `email`. Email-less accounts add an opaque `ownershipId` (persisted by Pi as `antigravityOwnershipId`) so token rotation cannot break catalog ownership; existing consumers can ignore it. This development work does not modify that plugin.
- **[pi-subscription-image](https://github.com/specode/pi-subscription-image):** its existing Codex/Grok functionality is unchanged. The planned Antigravity backend has been cancelled; this provider registers no image-generation API or tool. Earlier image evidence is retained only as historical research.

## Evidence and remaining acceptance

The earlier **2026-11-15** protocol investigation covered 17 generation requests, including native read-tool feasibility, strict prompt-opening controls, and one reference-image request. [The evidence manifest](./test/fixtures/agy-cli-1.5.9/manifest.json) distinguishes official captures from direct probes. Redacted records are structural evidence, not replayable requests.

Current offline tests exercise native Pi model/auth integration and real local Pi read-tool execution against mocked Gemini/Claude responses, plus malformed streams, cancellation, timeouts, signatures, concurrency, and cache isolation. OAuth application parameters were statically checked against the pinned official CLI archive; **this is not a live browser-login test**.

Local deployment also verified real account initialization and catalog discovery, persistence of six public models, and offline restoration by the installed CLI. Existing credentials were unchanged.

A separately authorized six-request Argon High diagnosis isolated a 429 to this repository's own injected instructions: they quoted the original Pi opening after the leading prompt had already been adapted. A strict same-request comparison changed only that documentation block to a source reference and returned 429 → 200. The literal example was removed from `AGENTS.md`, not from arbitrary user rules or history; a regression test prevents reintroduction. Small output caps and no tool execution mean this is not full tool-loop acceptance. Reload Pi's project rules before retrying an affected session.

The user subsequently reported successful real usage after the fix. This records local deployment/fix acceptance, not verified coverage of every model, tool continuation, login, resume, or cancellation path.

Remaining individually unverified areas: authorized `/login`, complete live tool-loop and session UI acceptance, and broader account/model coverage. Antigravity image generation is out of scope, not unfinished work. See [AGENTS.md](./AGENTS.md), the sole development/handoff entry point, for exact contracts and limitations.
