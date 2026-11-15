import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { accountCatalogKey, buildAntigravityCatalog } from "../src/catalog.ts";
import { DEFAULT_BASE_URL } from "../src/client.ts";

// Exercise Pi's real extension loader with no user state or network access.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(tmpdir(), "pi-antigravity-smoke-"));
try {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "..");
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const agentDir = join(temporary, "agent");
  mkdirSync(agentDir);
  const credential = { type: "oauth", access: "synthetic-access", refresh: "synthetic-refresh", expires: Date.now() + 3_600_000, projectId: "synthetic-project", email: "smoke@example.test" };
  const catalog = buildAntigravityCatalog({ models: { "gemini-3.8-flash-low": { displayName: "Synthetic Flash", model: "MODEL_SYNTHETIC_FLASH", maxTokens: 100_000, maxOutputTokens: 8000, supportsThinking: true, recommended: true } } });
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ antigravity: credential }), { mode: 0o600 });
  writeFileSync(join(agentDir, "models-store.json"), JSON.stringify({ antigravity: { models: catalog.models, checkedAt: Date.now(), antigravity: { schemaVersion: 1, accountKey: accountCatalogKey(credential), baseUrl: DEFAULT_BASE_URL, source: catalog.source } } }));
  const guard = join(temporary, "deny-network.cjs");
  writeFileSync(guard, 'globalThis.fetch = async () => { throw new Error("Network disabled in offline smoke test"); };\n');
  const result = spawnSync(process.execPath, ["--require", guard, join(packageRoot, manifest.bin.pi), "--no-extensions", "--no-skills", "--no-prompt-templates", "--offline", "-e", root, "--list-models"], {
    cwd: temporary,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
    encoding: "utf8",
    timeout: 30_000,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, output);
  assert.doesNotMatch(output, /failed to load|error loading|extension.*error|Network disabled/i);
  assert.match(output, /antigravity\s+gemini-3\.8-flash\s/, output);
  console.log("Isolated offline Pi extension load and disk catalog restoration passed.");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
