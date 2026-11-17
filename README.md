# pi-antigravity

[English](./README.md) | [简体中文](./README.zh-CN.md)

A [Pi](https://github.com/earendil-works/pi-mono) extension that adds the Antigravity (`antigravity`) provider so you can use Gemini, Claude, and GPT-OSS models with your Google Antigravity subscription.

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

If another package registering the `antigravity` provider is already installed (such as `pi-antigravity`), remove it first with `pi remove npm:pi-antigravity`. Only one `antigravity` provider should be installed at a time. Existing Antigravity credentials in `~/.pi/agent/auth.json` continue to work without signing in again.

## Usage

1. Run `/login`, pick `Sign in with an account` → `Antigravity`, and open the authorization URL in your browser.
2. Sign in with Google, click **Copy to Clipboard** on the Antigravity callback page, and paste the `4/...` authorization code into Pi. (Do not copy the browser address bar URL, as the page strips its query parameters after loading; a full callback URL with `code` and `state` is also accepted if copied before redirect cleanup.)
3. Run `/model` to pick an `antigravity` model and adjust its thinking effort.

### Models

The model list is fetched from Google's Cloud Code API for your account and cached in `~/.pi/agent/models-store.json` (refreshed every 4 hours, and restored from cache when starting Pi offline).

| Model ID | Name | Thinking levels | Context | Max output | Images |
| --- | --- | --- | --- | --- | --- |
| `gemini-4-argon` | Gemini 4 Argon | `low`, `medium`, `high` | 1M | 65.5K | Yes |
| `gemini-4-hydrogen` | Gemini 4 Hydrogen | `low`, `medium`, `high`, `xhigh` | 1M | 262.1K | Yes |
| `gemini-3.8-flash` | Gemini 3.8 Flash | `low`, `medium`, `high` | 1M | 65.5K | Yes |
| `claude-opus-5-5` | Claude Opus 5.5 | `low`, `medium`, `high` | 1M | 128K | Yes |
| `claude-sonnet-5-5` | Claude Sonnet 5.5 | `low`, `medium`, `high` | 1M | 128K | Yes |
| `gpt-oss-120b` | GPT-OSS 120B | `medium` | 131.1K | 32.8K | No |

### Notes

- **Chat and tool calling only**: This extension registers the `antigravity` chat provider. It does not add image generation, web search/fetch tools, multi-account rotation, or a quota UI.
- **Token usage and cost**: Prompt, cached, output, and thinking token counts are recorded on each turn. Partial updates retain previously valid counters; malformed counters are ignored, not coerced. If cached tokens exceed the reported prompt total, accounting uses zero uncached input and caps cached input at that total without interrupting generation. A bounded `antigravity.usage_anomaly` diagnostic retains valid numeric counters and invalid field names (never raw payloads); anomalous accounting is approximate until corrected by later metadata. Cost fields remain `0` for subscription usage.
- **Claude thinking continuity**: Consecutive thinking deltas are assembled until their signature, whether it arrives with text or in a separate text-less tail. Old same-model session fragments are reassembled only in the outgoing request; saved sessions are not rewritten. Text, tool calls and already signed blocks remain boundaries. Gemini's distinct signature-bearing parts are preserved.
- **Default system prompt compatibility**: Google's backend rejects some of Pi's built-in system prompt text with `429 RESOURCE_EXHAUSTED` (confirmed for the default opening and one line of the built-in documentation hints). When sending a request, the extension rewrites Pi's built-in prompt wording (the opening, built-in tool summaries and rules, documentation hints, and the project-instruction and skill-list headings) into equivalent text that does not name Pi. Only exact Pi 1.5.2 wording is rewritten; file paths, environment variable names, tool names and schemas, skill entries, other extensions' sections, your `AGENTS.md`, custom system prompts, user messages, and session files are passed through unchanged. Google may treat this as circumventing its third-party client detection; use it at your own account's risk.
- **Existing Cloud Code project required**: Your Google account must already have an active Antigravity / Cloud Code Assist project. Automatic GCP project creation and enterprise endpoints are not supported.

### Companion Extensions

- **[`@specode/pi-subscription-usage`](https://github.com/specode/pi-subscription-usage)**: Shows your Antigravity subscription quota (Gemini, Claude and GPT, and Gemini 4 Argon pools) in the footer status bar and via `/usage`. Works out of the box with the `antigravity` login from this extension.
- **[`@specode/pi-last-model-effort`](https://github.com/specode/pi-last-model-effort)**: Remembers the thinking effort you last picked for each model and restores it when switching models or starting a new TUI session.

## Privacy and Safety

- Credentials are stored and refreshed through Pi's own `~/.pi/agent/auth.json`. The extension never reads official CLI login files or OS keychain entries.
- Requests go only to official Google Cloud Code endpoints (`https://daily-cloudcode-pa.googleapis.com` by default) with HTTP redirects disabled.
- Access and refresh tokens are never written to model caches, session files, or error messages.
- Claude models receive each tool's original JSON Schema (including `anyOf` unions); Gemini and GPT-OSS models receive the legacy encoding observed from the official CLI.
- If a model, thinking level, or tool schema (`$ref` / `$dynamicRef` on Gemini and GPT-OSS models, or `strict: "require"`) is not supported by the backend, the request fails with an explicit error instead of silently downgrading or dropping tools.

## Development

```bash
# Install dependencies
npm ci

# Run tests
npm test

# Run typecheck, tests, isolated packed-extension smoke check, and package check
npm run check

# Load the extension directly in Pi without installing
pi --no-extensions --offline -e ./src/index.ts --list-models
```

## License

[MIT](./LICENSE). See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for protocol references and third-party notices.
