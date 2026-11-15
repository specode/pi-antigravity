# pi-antigravity

[English](./README.md) | [简体中文](./README.zh-CN.md)

A [Pi](https://github.com/earendil-works/pi-mono) extension that registers the Antigravity (`antigravity`) subscription chat provider using the official agy CLI HTTP protocol.

It connects directly to Google's Cloud Code API with your Antigravity subscription and reuses Pi's native OAuth storage, model catalog, tool execution, and session management—without running the official CLI binary, an ACP bridge, or a secondary agent loop.

## Installation

Requires Node.js >= 22.19.0 and Pi >= 1.5.2.

From npm:

```bash
pi install npm:@specode/pi-antigravity
```

From GitHub:

```bash
pi install git:github.com/specode/pi-antigravity
```

From a local directory for development:

```bash
pi install /path/to/pi-antigravity
```

Run `/reload` or restart Pi after installing.

If another package registering the `antigravity` provider ID (such as `pi-antigravity`) is installed, remove it first with `pi remove npm:pi-antigravity`. Only one `antigravity` provider should be loaded at a time. Existing Pi OAuth credentials in `~/.pi/agent/auth.json` are reused as-is.

## Usage

1. Run `/login`, choose `Sign in with an account` → `Antigravity` (`Sign in with Google (Antigravity subscription)`), and open the authorization URL in your browser.
2. After signing in with Google, click **Copy to Clipboard** on the Antigravity page and paste the authorization code into Pi. Use the code from this login attempt, not the address bar URL—the page removes its query parameters. A complete callback URL containing `code` and `state` is also accepted.
3. Run `/model` to select an `antigravity` model and adjust its thinking effort as needed.

### Model Discovery and Routing

| Aspect | Behavior |
| --- | --- |
| Catalog discovery | Calls `loadCodeAssist` and `fetchAvailableModels`, exposing curated chat models (`agentModelSorts` / `recommended`) and filtering out internal placeholders and image models |
| Thinking effort | Groups explicit `-low`, `-medium`, and `-high` runtime suffixes under one public model ID and maps the selected effort to `generationConfig.thinkingConfig`; unsupported effort levels fail explicitly without silent downgrades |
| Offline cache | Saves the last successful catalog per account in Pi's `models-store.json` (4-hour refresh TTL); restores cached models on offline startup and retains them if a refresh fails |
| Account isolation | Binds cached models to the authenticated account (`email` or derived `ownershipId`), `projectId`, and official endpoint; switching accounts hides the previous catalog |
| Token usage and cost | Populates prompt, cached, output, and thinking token counts from stream metadata; sets cost fields to `0` (unpriced subscription usage, not free API billing) |

### Companion Extensions

- **[`@specode/pi-subscription-usage`](https://github.com/specode/pi-subscription-usage)**: Displays Antigravity subscription quota pools (Gemini, Claude & GPT, and Gemini 4 Argon) in the footer status bar and via `/usage`. This provider preserves the `antigravity` provider ID, official Google endpoint, and `{ token, projectId, email }` credential bridge expected by `pi-subscription-usage`.
- **[`@specode/pi-last-model-effort`](https://github.com/specode/pi-last-model-effort)**: Remembers the thinking effort you last selected for each Antigravity model and restores it across model switches and new TUI sessions.

## Protocol and Boundaries

- **Official CLI HTTP alignment**: Targets consumer Antigravity subscriptions (`https://daily-cloudcode-pa.googleapis.com` by default; requires an existing Cloud Code Assist project, with no enterprise routing or automatic GCP project onboarding). Sends chat requests to `/v1internal:streamGenerateContent?alt=sse` with the `antigravity/cli/1.5.9` (build `1021519450`) client identity, host OS/architecture, `agent` request envelope, trajectory labels, and empty-seed 64-bit FNV-1a `sessionId`.
- **Public Pi converters and tool loop**: Resolves `@earendil-works/pi-ai`'s public Google message and tool converters through host package exports, preserving `thoughtSignature` (including signed empty text parts), paired tool-call IDs, and the verified `gemini-3.8-flash-low` function-response role adjustment. Tool schema types are uppercased only at JSON Schema keyword positions without altering property names or literal values; unsupported `$ref` / `$dynamicRef` schemas or `strict: "require"` contracts fail explicitly instead of silently dropping tools.
- **Targeted system prompt rewrite**: Rewrites only Pi's exact default two-sentence opening in the serialized request to `You are a coding agent helping the user with their project.` so the backend does not reject the default opening with `429 RESOURCE_EXHAUSTED`. User messages, session files, project rules, and custom prompts are never modified.
- **Focused scope**: Provides text chat, coding, and tool calling only. Does not include image generation/editing, web search/fetch tools, multi-account rotation, credit overage, background warming, or a built-in quota UI.
- **Predictable transport**: Makes a single HTTP request per turn with separate response-header (30s) and stream-idle (120s) timeouts. Never performs hidden retries or silent model, effort, or endpoint failover.

## Privacy and Safety

- Credentials are managed solely by Pi's native OAuth store (`auth.json`). The extension never reads, copies, or migrates official CLI credential files or OS keychain entries.
- Requests are sent only to allowlisted official HTTPS origins (`https://daily-cloudcode-pa.googleapis.com` by default, plus `https://cloudcode-pa.googleapis.com` and `https://daily-cloudcode-pa.sandbox.googleapis.com`) with HTTP redirects disabled (`redirect: "error"`).
- OAuth sign-in accepts the authorization code copied from the official page and exchanges it using this login attempt's independent S256 PKCE verifier. The copied code contains no `state`, so that path relies on the token endpoint's PKCE validation. Complete `https://antigravity.google/oauth-callback` URLs are also accepted, with strict origin/path checks and constant-time `state` validation; invalid URLs never fall back to bare-code parsing.
- OAuth and streaming error messages expose only allowlisted error codes or bounded diagnostic metadata and never include access or refresh tokens.

## Development

```bash
# Install dependencies
npm ci

# Run typecheck, offline tests, isolated packed-extension smoke test, and package check
npm run check

# Run offline unit and integration tests only
npm test

# Validate a published npm version in an isolated Pi environment with network blocked
npm run smoke -- @specode/pi-antigravity@0.1.2
```

Verification covers strict type checking, offline unit/integration suites (including local Pi `read`-tool execution against mocked Gemini/Claude streams), static checks against official agy CLI `1.5.9`, and bounded consumer-account testing on Pi `1.5.2`; live browser `/login` and exhaustive model/account combinations have not all been individually verified. See [AGENTS.md](./AGENTS.md) for architecture and verification boundaries, and [`test/fixtures/agy-cli-1.5.9/manifest.json`](./test/fixtures/agy-cli-1.5.9/manifest.json) for redacted protocol research fixtures.

## License

[MIT](./LICENSE). See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for protocol references and third-party notices.
