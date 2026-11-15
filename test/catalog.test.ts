import assert from "node:assert/strict";
import { test } from "node:test";
import { createModels, getSupportedThinkingLevels, InMemoryCredentialStore, InMemoryModelsStore, type Credential, type ModelsPublication, type ModelsStoreEntry, type Provider, type RefreshModelsContext } from "@earendil-works/pi-ai";
import { createAntigravityAuth, parseApiKey, getApiKey, type AntigravityOAuthCredential } from "../src/auth.ts";
import { accountCatalogKey, buildAntigravityCatalog, createAntigravityCatalog, type CatalogOptions, type AntigravityCatalogController } from "../src/catalog.ts";
import { DEFAULT_BASE_URL, type postJson } from "../src/client.ts";

const credential = (extra = {}): AntigravityOAuthCredential => ({ type: "oauth", access: "synthetic-access", refresh: "synthetic-refresh", expires: Date.now() + 3_600_000, projectId: "synthetic-project", email: "alice@example.test", ...extra });
const info = (extra = {}) => ({ displayName: "Synthetic Flash (Low)", model: "MODEL_SYNTHETIC_LOW", supportsThinking: true, supportsImages: true, maxTokens: 100_000, maxOutputTokens: 8192, ...extra });
function directory() {
  return { models: {
    "gemini-synthetic-flash-low": info(),
    "gemini-synthetic-flash-high": info({ displayName: "Synthetic Flash (High)", model: "MODEL_SYNTHETIC_HIGH", maxTokens: 80_000, maxOutputTokens: 4096, supportsImages: false }),
    "chat-synthetic": info({ displayName: "Synthetic Chat", model: "MODEL_SYNTHETIC_CHAT", supportsThinking: false }),
    "gemini-synthetic-image": info(),
    "MODEL_PLACEHOLDER_SYNTHETIC": info(),
    "gemini-synthetic-internal-low": info({ isInternal: true }),
    "gemini-synthetic-disabled-low": info({ disabled: true }),
    "gemini-synthetic-unlisted-low": info(),
  }, agentModelSorts: [{ groups: [{ modelIds: ["gemini-synthetic-flash-low", "gemini-synthetic-flash-high", "chat-synthetic", "gemini-synthetic-image", "MODEL_PLACEHOLDER_SYNTHETIC", "gemini-synthetic-internal-low", "gemini-synthetic-disabled-low"] }] }], imageGenerationModelIds: ["gemini-synthetic-image"],
  accountSecret: "should-not-be-persisted", quotaInfo: { private: "not-cached" } };
}
function transport(result: () => unknown = directory, calls: unknown[][] = []): typeof postJson {
  return async (...args) => {
    calls.push(args);
    if (args[1] === "/v1internal:loadCodeAssist") return { cloudaicompanionProject: "synthetic-project" };
    assert.equal(args[1], "/v1internal:fetchAvailableModels");
    return result();
  };
}
function harness(controller: AntigravityCatalogController, options: { credential?: Credential; stored?: ModelsStoreEntry; publish?: (publication: ModelsPublication) => Promise<boolean> } = {}) {
  let stored = options.stored;
  const publications: ModelsPublication[] = [];
  const context = (extra: Partial<RefreshModelsContext> = {}): RefreshModelsContext => ({
    credential: options.credential ?? credential(), stored, signal: new AbortController().signal, allowNetwork: true,
    async publish(publication) {
      publications.push(publication);
      if (options.publish) return options.publish(publication);
      if (publication.persist === null) stored = undefined;
      else if (publication.persist) stored = structuredClone(publication.persist);
      publication.update?.();
      return true;
    }, ...extra,
  });
  return { context, publications, stored: () => stored, refresh: (extra: Partial<RefreshModelsContext> = {}) => controller.refreshModels(context(extra)) };
}

test("discovery groups only explicit runtimes and retains model enum, exact effort and conservative capabilities", () => {
  const catalog = buildAntigravityCatalog(directory());
  assert.deepEqual(catalog.models.map(model => model.id), ["gemini-synthetic-flash", "chat-synthetic"]);
  const flash = catalog.models[0];
  assert.equal(flash.contextWindow, 80_000); assert.equal(flash.maxTokens, 4096); assert.deepEqual(flash.input, ["text"]);
  assert.deepEqual(getSupportedThinkingLevels(flash), ["low", "high"]);
  assert.equal(catalog.routes[flash.id].default.runtimeId, "gemini-synthetic-flash-low");
  assert.deepEqual(catalog.routes[flash.id].levels.high, { runtimeId: "gemini-synthetic-flash-high", modelEnum: "MODEL_SYNTHETIC_HIGH", thinkingLevel: "HIGH" });
  assert.equal(flash.api, "antigravity"); assert.equal(flash.baseUrl, DEFAULT_BASE_URL);
  assert.deepEqual(flash.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(catalog.routes["chat-synthetic"].default.thinkingLevel, undefined);
  assert.equal(catalog.models[1].reasoning, false);
});

test("proto3 omitted booleans mean false, not missing mandatory capability metadata", () => {
  const catalog = buildAntigravityCatalog({ models: { "plain-chat": { model: "MODEL_SYNTHETIC", maxTokens: 3000, maxOutputTokens: 1000, recommended: true } } });
  assert.equal(catalog.models[0].reasoning, false); assert.deepEqual(catalog.models[0].input, ["text"]);
});

test("directory thinkingLevel is an int32, retained without inventing its wire effort semantics", () => {
  const catalog = buildAntigravityCatalog({ models: { "synthetic-low": info({ recommended: true, thinkingLevel: 7 }) } });
  assert.deepEqual(getSupportedThinkingLevels(catalog.models[0]), ["low"]);
  assert.equal(catalog.routes["synthetic"].default.thinkingLevel, "LOW");
  assert.equal(catalog.source.models["synthetic-low"].thinkingLevel, 7);
  for (const thinkingLevel of ["THINKING_LEVEL_HIGH", "HIGH", 1.5, 2147483648]) {
    assert.throws(() => buildAntigravityCatalog({ models: { "synthetic-low": info({ recommended: true, thinkingLevel }) } }), /catalog/);
  }
  assert.throws(() => buildAntigravityCatalog({ models: { "synthetic-agent": info({ recommended: true, thinkingLevel: 7 }) } }), /catalog/);
});

test("unverified unsuffixed thinking runtimes are not advertised", () => {
  assert.throws(() => buildAntigravityCatalog({ models: { "synthetic-agent": info({ recommended: true }) } }), /catalog/);
});

test("curated visibility excludes unlisted runtimes without fallback to all internal entries", () => {
  assert.throws(() => buildAntigravityCatalog({ ...directory(), agentModelSorts: [] }), /catalog/);
  assert.throws(() => buildAntigravityCatalog({ models: directory().models }), /catalog/);
  const source = { models: { "synthetic-low": info({ recommended: true }), "synthetic-hidden-low": info() } };
  assert.deepEqual(buildAntigravityCatalog(source).models.map(model => model.id), ["synthetic"]);
});

test("catalog parser rejects malformed selection, limits and metadata rather than guessing", () => {
  for (const payload of [null, [], {}, { models: [] }, { models: {}, agentModelSorts: [] }, { models: { "synthetic-low": info() }, agentModelSorts: {} }]) {
    assert.throws(() => buildAntigravityCatalog(payload));
  }
  for (const extra of [{ maxTokens: 0 }, { maxTokens: "1000" }, { maxOutputTokens: -1 }, { maxOutputTokens: 1.5 }, { model: "actual-runtime-not-enum" }, { supportsThinking: "true" }, { supportsImages: "true" }, { supportsThinking: false }]) {
    assert.throws(() => buildAntigravityCatalog({ models: { "synthetic-low": info({ recommended: true, ...extra }) } }), /catalog/);
  }
});

test("model API and endpoints are explicit and unsafe endpoints fail before transport", async () => {
  assert.equal(buildAntigravityCatalog(directory(), DEFAULT_BASE_URL, "synthetic-api").models[0].api, "synthetic-api");
  assert.throws(() => createAntigravityCatalog({ baseUrl: "https://evil.test" }));
  const controller = createAntigravityCatalog({ postJson: async () => { assert.fail("Unsafe request"); } });
  await assert.rejects(harness(controller).refresh({ baseUrl: "https://evil.test" }));
});

test("native refresh initializes then fetches with the same project, origin and abort signal", async () => {
  const calls: unknown[][] = [];
  const controller = createAntigravityCatalog({ postJson: transport(directory, calls), now: () => 10_000 });
  const h = harness(controller); const abort = new AbortController();
  await h.refresh({ signal: abort.signal });
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], DEFAULT_BASE_URL); assert.equal(calls[1][0], DEFAULT_BASE_URL);
  assert.deepEqual(calls[1][3], { project: "synthetic-project" });
  assert.equal(calls[0][4], abort.signal); assert.equal(calls[1][4], abort.signal);
  assert.equal(h.stored()?.checkedAt, 10_000); assert.equal(controller.getModels().length, 2);
  assert.equal(h.publications.length, 1); assert.ok(h.publications[0].persist); assert.ok(h.publications[0].update);
});

test("cache persists only normalized model data and an account fingerprint", async () => {
  const controller = createAntigravityCatalog({ postJson: transport() }); const h = harness(controller); await h.refresh();
  const stored = JSON.stringify(h.stored());
  for (const secret of ["synthetic-access", "synthetic-refresh", "alice@example.test", "synthetic-project", "should-not-be-persisted", "quotaInfo", "not-cached", "tokenDigest"]) assert.equal(stored.includes(secret), false, secret);
  assert.equal(stored.includes("schemaVersion"), true);
});

test("offline startup restores account-owned routing from Pi persistence without network", async () => {
  const live = createAntigravityCatalog({ postJson: transport() }); const h = harness(live); await h.refresh();
  const offline = createAntigravityCatalog({ postJson: async () => { assert.fail("Offline I/O"); } });
  await harness(offline, { stored: JSON.parse(JSON.stringify(h.stored())) }).refresh({ allowNetwork: false });
  assert.deepEqual(offline.getModels(), live.getModels());
  assert.deepEqual(offline.resolveRoute("gemini-synthetic-flash", "high"), live.resolveRoute("gemini-synthetic-flash", "high"));
});

test("model refresh TTL, force, clock rollback and token-only rotation obey native context", async () => {
  const calls: unknown[][] = []; let now = 1000;
  const controller = createAntigravityCatalog({ postJson: transport(directory, calls), now: () => now, refreshIntervalMs: 5000 }); const h = harness(controller);
  await h.refresh(); await h.refresh(); assert.equal(calls.length, 2);
  await h.refresh({ credential: credential({ access: "rotated-access", refresh: "rotated-refresh" }) }); assert.equal(calls.length, 2);
  controller.assertOwnership(parseApiKey(getApiKey(credential({ access: "rotated-access" }))));
  await h.refresh({ force: true }); assert.equal(calls.length, 4);
  now = 500; await h.refresh(); assert.equal(calls.length, 6);
  now = 10_000; await h.refresh(); assert.equal(calls.length, 8);
});

test("same-account HTTP and parser failures keep the last successful list and cache", async () => {
  let result: () => unknown = directory;
  const controller = createAntigravityCatalog({ postJson: transport(() => result()), refreshIntervalMs: 0 }); const h = harness(controller); await h.refresh();
  const before = controller.getModels(); const stored = structuredClone(h.stored());
  const failure = Object.assign(new Error("synthetic denial"), { status: 403, details: { reason: "SYNTHETIC_DENIED" } });
  result = () => { throw failure; };
  await assert.rejects(h.refresh(), error => error === failure);
  assert.deepEqual(controller.getModels(), before); assert.deepEqual(h.stored(), stored);
  result = () => ({ models: {} }); await assert.rejects(h.refresh(), /catalog/);
  assert.deepEqual(controller.getModels(), before); assert.deepEqual(h.stored(), stored);
});

test("changed initialization project does not silently route with old credentials", async () => {
  const controller = createAntigravityCatalog({ postJson: async (_origin, path) => {
    assert.equal(path, "/v1internal:loadCodeAssist"); return { cloudaicompanionProject: "other-project" };
  } });
  await assert.rejects(harness(controller).refresh(), /different Cloud Code Assist project/);
  assert.deepEqual(controller.getModels(), []);
});

test("account keys are stable on token rotation and isolated by email, project, fallback refresh and origin", () => {
  const original = credential(); const key = accountCatalogKey(original)!;
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(accountCatalogKey(credential({ access: "other", refresh: "other", email: "ALICE@example.test" })), key);
  for (const input of [credential({ email: "bob@example.test" }), credential({ projectId: "other" }), credential({ email: undefined })]) assert.notEqual(accountCatalogKey(input), key);
  assert.notEqual(accountCatalogKey(original, "https://cloudcode-pa.googleapis.com"), key);
  const noEmail = credential({ email: undefined });
  assert.notEqual(accountCatalogKey(noEmail), accountCatalogKey({ ...noEmail, refresh: "other" }));
  assert.equal(accountCatalogKey(undefined), undefined); assert.equal(accountCatalogKey({ type: "api_key", key: "raw" }), undefined);
});

test("offline cache is not hydrated for a different account, project, origin or unknown schema", async () => {
  const live = createAntigravityCatalog({ postJson: transport() }); const h = harness(live); await h.refresh();
  for (const extra of [{ credential: credential({ email: "bob@example.test" }) }, { credential: credential({ projectId: "other" }) }, { baseUrl: "https://cloudcode-pa.googleapis.com" }, { credential: undefined }]) {
    const offline = createAntigravityCatalog();
    const context = harness(offline, { stored: h.stored() }).context({ ...extra, allowNetwork: false });
    await offline.refreshModels(context); assert.deepEqual(offline.getModels(), []);
  }
  const legacy: ModelsStoreEntry = { models: live.getModels() };
  const offline = createAntigravityCatalog(); await harness(offline, { stored: legacy }).refresh({ allowNetwork: false });
  assert.deepEqual(offline.getModels(), []);
});

test("account changes hide previous memory before failed discovery without deleting another account's cache", async () => {
  let fail = false;
  const controller = createAntigravityCatalog({ postJson: transport(() => { if (fail) throw new Error("synthetic failure"); return directory(); }) });
  const h = harness(controller); await h.refresh(); const previous = structuredClone(h.stored());
  fail = true;
  await assert.rejects(h.refresh({ credential: credential({ email: "bob@example.test" }) }), /synthetic failure/);
  assert.deepEqual(controller.getModels(), []); assert.deepEqual(h.stored(), previous);
});

test("filtering and direct route ownership checks reject stale accounts even before refresh", async () => {
  const controller = createAntigravityCatalog({ postJson: transport() }); const h = harness(controller); await h.refresh();
  const models = controller.getModels();
  assert.deepEqual(controller.filterModels(models, credential()), models);
  assert.deepEqual(controller.filterModels(models, credential({ email: "bob@example.test" })), []);
  assert.deepEqual(controller.filterModels(models, undefined), []);
  assert.doesNotThrow(() => controller.assertOwnership(parseApiKey(getApiKey(credential()))));
  for (const input of [credential({ email: "bob@example.test" }), credential({ projectId: "other" }), credential({ email: undefined })]) {
    assert.throws(() => controller.resolveRoute(models[0].id, "low", parseApiKey(getApiKey(input))), /different account/);
  }
  assert.throws(() => controller.assertOwnership({ ...parseApiKey(getApiKey(credential())), baseUrl: "https://cloudcode-pa.googleapis.com" }), /different account/);
});

test("email-less ownership survives rotation and rejects different accounts and unbound legacy tokens", async () => {
  const input = credential({ email: undefined }); const controller = createAntigravityCatalog({ postJson: transport() });
  await harness(controller, { credential: input }).refresh();
  const material = parseApiKey(getApiKey(input));
  controller.assertOwnership(material);
  const rotated = { ...input, access: "other", refresh: "rotated", antigravityOwnershipId: material.ownershipId };
  controller.assertOwnership(parseApiKey(getApiKey(rotated)));
  assert.deepEqual(controller.filterModels(controller.getModels(), rotated), controller.getModels());
  assert.equal(accountCatalogKey(input), accountCatalogKey(rotated));
  assert.throws(() => controller.assertOwnership({ projectId: input.projectId }), /different account/);
  assert.throws(() => controller.assertOwnership(parseApiKey(getApiKey({ ...input, refresh: "different-account" }))), /different account/);
  // Existing minimal JSON callers remain accepted only while their access token matches.
  controller.assertOwnership({ token: input.access, projectId: input.projectId });
  assert.throws(() => controller.assertOwnership({ token: "other", projectId: input.projectId }), /different account/);
});

test("unsupported efforts and unknown generations fail rather than falling back", async () => {
  const controller = createAntigravityCatalog({ postJson: transport() }); await harness(controller).refresh();
  for (const level of ["off", "minimal", "medium", "xhigh", "max"] as const) assert.throws(() => controller.resolveRoute("gemini-synthetic-flash", level));
  assert.throws(() => controller.resolveRoute("gemini-other-generation", "low"));
  assert.equal(controller.resolveRoute("gemini-synthetic-flash").runtimeId, "gemini-synthetic-flash-low");
  assert.equal(controller.resolveRoute("chat-synthetic", "off").thinkingLevel, undefined);
});

test("callers cannot mutate model or route snapshots", async () => {
  const controller = createAntigravityCatalog({ postJson: transport() }); await harness(controller).refresh();
  const models = controller.getModels(); models[0].name = "mutated"; models[0].cost.input = 9;
  const route = controller.resolveRoute("gemini-synthetic-flash"); route.runtimeId = "mutated";
  assert.notEqual(controller.getModels()[0].name, "mutated"); assert.equal(controller.getModels()[0].cost.input, 0);
  assert.notEqual(controller.resolveRoute("gemini-synthetic-flash").runtimeId, "mutated");
});

test("publication rejection and storage failures cannot mutate provider state", async () => {
  const controller = createAntigravityCatalog({ postJson: transport() });
  await harness(controller, { publish: async () => false }).refresh(); assert.deepEqual(controller.getModels(), []);
  await assert.rejects(harness(controller, { publish: async () => { throw new Error("synthetic disk failure"); } }).refresh(), /disk failure/);
  assert.deepEqual(controller.getModels(), []);
});

test("cancellation stops initialization and prevents late discovery publication", async () => {
  const pre = new AbortController(); pre.abort();
  const noTransport = createAntigravityCatalog({ postJson: async () => { assert.fail("Aborted I/O"); } });
  await assert.rejects(harness(noTransport).refresh({ signal: pre.signal }), { name: "AbortError" });
  const mid = new AbortController();
  const controller = createAntigravityCatalog({ postJson: transport(() => { mid.abort(); return directory(); }) }); const h = harness(controller);
  await assert.rejects(h.refresh({ signal: mid.signal }), { name: "AbortError" });
  assert.equal(h.publications.length, 0); assert.deepEqual(controller.getModels(), []);
});

test("superseded refresh cannot publish stale state even with a non-cooperative transport", async () => {
  let resolve!: (value: unknown) => void; let requests = 0;
  const controller = createAntigravityCatalog({ postJson: async (_origin, path) => {
    if (path === "/v1internal:loadCodeAssist") return { cloudaicompanionProject: "synthetic-project" };
    requests++;
    return requests === 1 ? new Promise(done => { resolve = done; }) : directory();
  } });
  const h = harness(controller); const old = h.refresh();
  while (!resolve) await new Promise(done => setImmediate(done));
  await h.refresh({ credential: credential({ email: "bob@example.test" }) });
  resolve(directory()); await old;
  assert.equal(h.publications.filter(publication => publication.persist).length, 1);
  controller.assertOwnership(parseApiKey(getApiKey(credential({ email: "bob@example.test" }))));
});

test("invalid persisted source is ignored and cannot install forged URLs or routes", async () => {
  const live = createAntigravityCatalog({ postJson: transport() }); const h = harness(live); await h.refresh();
  const stored = structuredClone(h.stored()) as ModelsStoreEntry & { antigravity: { source: unknown } };
  stored.models[0].baseUrl = "https://evil.test"; stored.antigravity.source = { models: {} };
  const offline = createAntigravityCatalog(); await harness(offline, { stored }).refresh({ allowNetwork: false });
  assert.deepEqual(offline.getModels(), []);
});

test("native Models refresh restores through public persistence and isolates account replacement", async () => {
  const credentials = new InMemoryCredentialStore(); const modelsStore = new InMemoryModelsStore();
  await credentials.modify("antigravity", async () => credential());
  const make = (options: CatalogOptions): { controller: AntigravityCatalogController; provider: Provider } => {
    const controller = createAntigravityCatalog(options);
    return { controller, provider: { id: "antigravity", name: "Antigravity", baseUrl: DEFAULT_BASE_URL, auth: createAntigravityAuth(),
      getModels: controller.getModels, filterModels: controller.filterModels, refreshModels: controller.refreshModels,
      stream() { throw new Error("Not used"); }, streamSimple() { throw new Error("Not used"); } } };
  };
  const a = make({ postJson: transport() }); const runtime = createModels({ credentials, modelsStore }); runtime.setProvider(a.provider);
  assert.equal((await runtime.refresh()).errors.size, 0); assert.equal(runtime.getModels().length, 2);
  const b = make({ postJson: async () => { assert.fail("No network on offline restore"); } });
  const restarted = createModels({ credentials, modelsStore }); restarted.setProvider(b.provider);
  assert.equal((await restarted.refresh({ allowNetwork: false })).errors.size, 0); assert.equal(restarted.getModels().length, 2);
  await credentials.modify("antigravity", async () => credential({ email: "bob@example.test" }));
  assert.deepEqual(await restarted.getAvailable(), []);
  await restarted.refresh({ allowNetwork: false }); assert.deepEqual(restarted.getModels(), []);
  assert.ok(await modelsStore.read("antigravity"));
});
