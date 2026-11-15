import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { accountCatalogKey, buildAntigravityCatalog } from "../src/catalog.ts";
import { DEFAULT_BASE_URL } from "../src/client.ts";

// Load the actual tarball outside the checkout: devDependencies must not mask
// missing host imports. Neither the package nor the fixture has real credentials.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publishedPackage = process.argv[2];
assert.ok(process.argv.length <= 3, "Expected at most one published package specifier");
if (publishedPackage !== undefined) {
  assert.match(publishedPackage, /^@specode\/pi-antigravity@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
}
const temporary = mkdtempSync(join(tmpdir(), "pi-antigravity-smoke-"));
try {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "..");
  const hostManifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const packed = spawnSync("npm", ["pack", ...(publishedPackage ? [publishedPackage] : []), "--json", "--ignore-scripts", "--pack-destination", temporary], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(packed.error, undefined, String(packed.error));
  assert.equal(packed.status, 0, `${packed.stdout ?? ""}\n${packed.stderr ?? ""}`);
  const [{ filename }] = JSON.parse(packed.stdout);
  assert.equal(filename, filename.split(/[\\/]/).at(-1));
  execFileSync("tar", ["-xzf", join(temporary, filename), "-C", temporary]);
  const installed = join(temporary, "package");
  const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  assert.equal(manifest.name, "@specode/pi-antigravity");
  assert.deepEqual(manifest.pi.extensions, ["./src/index.ts"]);

  const agentDir = join(temporary, "agent");
  mkdirSync(agentDir);
  const credential = { type: "oauth", access: "synthetic-access", refresh: "synthetic-refresh", expires: Date.now() + 3_600_000, projectId: "synthetic-project", email: "smoke@example.test" };
  const catalog = buildAntigravityCatalog({ models: { "gemini-3.8-flash-low": { displayName: "Synthetic Flash", model: "MODEL_SYNTHETIC_FLASH", maxTokens: 100_000, maxOutputTokens: 8000, supportsThinking: true, recommended: true } } });
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ antigravity: credential }), { mode: 0o600 });
  writeFileSync(join(agentDir, "models-store.json"), JSON.stringify({ antigravity: { models: catalog.models, checkedAt: Date.now(), antigravity: { schemaVersion: 1, accountKey: accountCatalogKey(credential), baseUrl: DEFAULT_BASE_URL, source: catalog.source } } }));
  const guard = join(temporary, "deny-network.cjs");
  writeFileSync(guard, 'globalThis.fetch = async () => { throw new Error("Network disabled in offline smoke test"); };\n');
  const result = spawnSync(process.execPath, ["--require", guard, join(packageRoot, hostManifest.bin.pi), "--no-extensions", "--no-skills", "--no-prompt-templates", "--offline", "-e", installed, "--list-models"], {
    cwd: temporary,
    env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "", PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
    encoding: "utf8",
    timeout: 30_000,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, output);
  assert.doesNotMatch(output, /failed to load|error loading|extension.*error|Network disabled/i);
  assert.match(output, /antigravity\s+gemini-3\.8-flash\s/, output);
  console.log("Packed extension load and offline disk catalog restoration passed without extension devDependencies.");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
