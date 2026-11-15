import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels, InMemoryCredentialStore, InMemoryModelsStore, type Context, type OAuthCredential, type Provider } from "@earendil-works/pi-ai";
import { createReadTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension, { antigravityProvider } from "../src/index.ts";
import { CLIENT_USER_AGENT } from "../src/client.ts";

const credential: OAuthCredential = {
  type: "oauth", access: "synthetic-access", refresh: "synthetic-refresh", expires: Date.now() + 3_600_000,
  projectId: "synthetic-project", email: "synthetic@example.test",
};
const catalog = {
  models: {
    "gemini-3.8-flash-low": { model: "MODEL_PLACEHOLDER_M320", displayName: "Gemini Flash (Low)", maxTokens: 100_000, maxOutputTokens: 8000, supportsThinking: true, supportsImages: true },
    "claude-sonnet-5-5-low": { model: "MODEL_PLACEHOLDER_M403", displayName: "Claude Sonnet (Low)", maxTokens: 100_000, maxOutputTokens: 8000, supportsThinking: true, supportsImages: true },
  },
  agentModelSorts: [{ groups: [{ modelIds: ["gemini-3.8-flash-low", "claude-sonnet-5-5-low"] }] }],
  imageGenerationModelIds: [],
};
function sse(parts: unknown[], finishReason = "STOP"): Response {
  const envelope = { response: { candidates: [{ content: { role: "model", parts }, finishReason }], responseId: "synthetic-response", modelVersion: "confirmed-runtime", usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 3, thoughtsTokenCount: 2, totalTokenCount: 25 } } };
  return new Response(`data: ${JSON.stringify(envelope)}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
}
async function runtime(fetch: typeof globalThis.fetch, credentials = new InMemoryCredentialStore(), store = new InMemoryModelsStore()) {
  await credentials.modify("antigravity", async () => structuredClone(credential));
  const models = createModels({ credentials, modelsStore: store });
  models.setProvider(antigravityProvider({ fetch }));
  const refreshed = await models.refresh({ providers: ["antigravity"] });
  assert.equal(refreshed.errors.size, 0, [...refreshed.errors.values()].map(String).join("; "));
  return { models, credentials, store };
}

test("extension registers exactly one native provider and no tools or UI", () => {
  const registrations: Provider[] = [];
  extension({ registerProvider: (provider: Provider) => registrations.push(provider) } as unknown as ExtensionAPI);
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0]!.id, "antigravity");
  assert.deepEqual(registrations[0]!.getModels(), []);
  assert.equal(typeof registrations[0]!.refreshModels, "function");
  assert.ok(registrations[0]!.auth.oauth?.isSubscription);
});

for (const publicId of ["gemini-3.8-flash", "claude-sonnet-5-5"]) {
  test(`native Models and Pi read tool complete a mocked ${publicId} round trip`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agy-native-read-"));
    try {
      await writeFile(join(workspace, "probe.txt"), "AGY_NATIVE_READ_OK\n");
      const requests: any[] = [];
      const fakeFetch: typeof fetch = async (input, init) => {
        const url = String(input);
        assert.equal(init?.redirect, "error");
        assert.equal(new Headers(init?.headers).get("User-Agent"), CLIENT_USER_AGENT);
        assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer synthetic-access");
        if (url.endsWith(":loadCodeAssist")) return Response.json({ cloudaicompanionProject: "synthetic-project" });
        if (url.endsWith(":fetchAvailableModels")) return Response.json(catalog);
        assert.ok(url.endsWith(":streamGenerateContent?alt=sse"));
        const payload = JSON.parse(String(init?.body));
        requests.push(payload);
        if (requests.length === 1) return sse([{ functionCall: { id: "call_read_1", name: "read", args: { path: "probe.txt" } }, thoughtSignature: "c2lnbmF0dXJl" }]);
        const parts = payload.request.contents.flatMap((content: any) => content.parts);
        assert.ok(parts.some((part: any) => part.functionResponse?.id === "call_read_1"));
        assert.ok(parts.some((part: any) => part.functionCall?.id === "call_read_1" && part.thoughtSignature === "c2lnbmF0dXJl"));
        assert.match(JSON.stringify(parts.find((part: any) => part.functionResponse)?.functionResponse), /AGY_NATIVE_READ_OK/);
        return sse([{ text: "AGY_PI_TOOL_OK" }, { text: "", thoughtSignature: "ZmluYWwtc2ln" }]);
      };
      const { models } = await runtime(fakeFetch);
      const model = models.getModel("antigravity", publicId)!;
      assert.ok(model);
      const read = createReadTool(workspace);
      const context: Context = { systemPrompt: "You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.\nKeep project rules.", tools: [read], messages: [{ role: "user", content: "Read probe.txt", timestamp: 1 }] };
      const original = structuredClone(context.messages);
      const first = await models.completeSimple(model, context, { reasoning: "low", sessionId: "synthetic-session" });
      assert.equal(first.stopReason, "toolUse", first.errorMessage ?? "Expected a tool call");
      const call = first.content.find(block => block.type === "toolCall");
      assert.ok(call && call.type === "toolCall");
      const result = await read.execute(call.id, { path: String(call.arguments.path) });
      assert.deepEqual(context.messages, original);
      context.messages.push(first, { role: "toolResult", toolCallId: call.id, toolName: call.name, content: result.content, isError: false, timestamp: 2 });
      const second = await models.completeSimple(model, context, { reasoning: "low", sessionId: "synthetic-session" });
      assert.equal(second.stopReason, "stop", second.errorMessage ?? "Expected a completed tool round trip");
      assert.ok(second.content.some(block => block.type === "text" && block.text === "AGY_PI_TOOL_OK"));
      assert.ok(second.content.some(block => block.type === "text" && block.textSignature === "ZmluYWwtc2ln"));
      assert.equal(second.responseModel, "confirmed-runtime");
      assert.equal(second.usage.output, 5);
      assert.equal(second.usage.totalTokens, 25);
      assert.equal(second.usage.cost.total, 0);
      assert.equal(requests[0].request.labels.cascade_id, requests[1].request.labels.cascade_id);
      assert.equal(requests[0].request.labels.trajectory_id, requests[1].request.labels.trajectory_id);
      assert.notEqual(requests[0].requestId, requests[1].requestId);
      assert.equal(requests[1].request.labels.last_step_index, "2");
      assert.match(requests[1].request.systemInstruction.parts[0].text, /^You are a coding agent helping the user with their project\.\nKeep project rules\.$/);
      assert.match(context.systemPrompt!, /running inside pi/);
    } finally { await rm(workspace, { recursive: true, force: true }); }
  });
}

test("native chat refreshes OAuth through the injected transport without losing catalog ownership", async () => {
  let refreshCalls = 0;
  let generationCalls = 0;
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === "https://oauth2.googleapis.com/token") {
      refreshCalls++;
      assert.equal(new URLSearchParams(String(init?.body)).get("grant_type"), "refresh_token");
      return Response.json({ access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 3600, token_type: "Bearer" });
    }
    if (url.endsWith(":loadCodeAssist")) return Response.json({ cloudaicompanionProject: "synthetic-project" });
    if (url.endsWith(":fetchAvailableModels")) return Response.json(catalog);
    generationCalls++;
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer rotated-access");
    return sse([{ text: "REFRESH_OK" }]);
  };
  const { models, credentials } = await runtime(fakeFetch);
  const model = models.getModel("antigravity", "gemini-3.8-flash")!;
  await credentials.modify("antigravity", async () => ({ ...credential, expires: 0 }));
  const response = await models.completeSimple(model, { messages: [{ role: "user", content: "Synthetic refresh test", timestamp: 1 }] }, { reasoning: "low", sessionId: "refresh-session" });
  assert.equal(response.stopReason, "stop", response.errorMessage ?? "Expected success after refresh");
  assert.equal(refreshCalls, 1);
  assert.equal(generationCalls, 1);
  const stored = await credentials.read("antigravity");
  assert.ok(stored?.type === "oauth");
  assert.equal(stored.refresh, "rotated-refresh");
  assert.equal(stored.email, credential.email);
});

for (const rotateRefresh of [false, true]) {
  test(`native email-less credentials survive automatic refresh (rotation=${rotateRefresh}) without directory refresh`, async () => {
    const credentials = new InMemoryCredentialStore();
    const store = new InMemoryModelsStore();
    const legacy: OAuthCredential = { ...credential, email: undefined, expires: Date.now() + 120_000 };
    await credentials.modify("antigravity", async () => legacy);
    const models = createModels({ credentials, modelsStore: store });
    let refreshCalls = 0;
    let discoveryCalls = 0;
    const requests: any[] = [];
    models.setProvider(antigravityProvider({ fetch: async (input, init) => {
      const url = String(input);
      if (url === "https://oauth2.googleapis.com/token") {
        refreshCalls++;
        return Response.json({ access_token: `email-less-access-${refreshCalls}`, ...(rotateRefresh ? { refresh_token: `email-less-refresh-${refreshCalls}` } : {}), expires_in: 3600, token_type: "Bearer" });
      }
      if (url.endsWith(":loadCodeAssist")) { discoveryCalls++; return Response.json({ cloudaicompanionProject: "synthetic-project" }); }
      if (url.endsWith(":fetchAvailableModels")) { discoveryCalls++; return Response.json(catalog); }
      assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer email-less-access-${refreshCalls}`);
      requests.push(JSON.parse(String(init?.body)));
      return sse([{ text: "EMAIL_LESS_REFRESH_OK" }]);
    } }));
    const refreshed = await models.refresh({ providers: ["antigravity"] });
    assert.equal(refreshed.errors.size, 0);
    assert.equal(refreshCalls, 0);
    const model = models.getModel("antigravity", "gemini-3.8-flash")!;
    const snapshot = await store.read("antigravity");
    let ownershipId: unknown;
    for (let index = 0; index < 2; index++) {
      if (index) await credentials.modify("antigravity", async current => ({ ...current!, expires: 0 }));
      const result = await models.completeSimple(model, { messages: [{ role: "user", content: "Synthetic legacy credential test", timestamp: 1 }] }, { reasoning: "low", sessionId: "legacy-session" });
      assert.equal(result.stopReason, "stop", result.errorMessage ?? "Expected legacy credential refresh success");
      const stored = await credentials.read("antigravity");
      assert.ok(stored?.type === "oauth");
      assert.equal(typeof stored.antigravityOwnershipId, "string");
      if (index === 0) ownershipId = stored.antigravityOwnershipId;
      else assert.equal(stored.antigravityOwnershipId, ownershipId);
      assert.equal((await models.getAvailable("antigravity")).length, 2);
    }
    assert.equal(refreshCalls, 2);
    assert.equal(discoveryCalls, 2);
    assert.equal(requests[0].request.labels.cascade_id, requests[1].request.labels.cascade_id);
    assert.deepEqual(await store.read("antigravity"), snapshot);
    const resumed = createModels({ credentials, modelsStore: store });
    resumed.setProvider(antigravityProvider({ fetch: async () => { assert.fail("Offline resume must not fetch"); } }));
    const restored = await resumed.refresh({ providers: ["antigravity"], allowNetwork: false });
    assert.equal(restored.errors.size, 0);
    assert.equal((await resumed.getAvailable("antigravity")).length, 2);
    assert.equal(legacy.antigravityOwnershipId, undefined);
  });
}

test("direct native chat rejects a stale account route before generation", async () => {
  let generationCalls = 0;
  const { models, credentials } = await runtime(async input => {
    const url = String(input);
    if (url.endsWith(":loadCodeAssist")) return Response.json({ cloudaicompanionProject: "synthetic-project" });
    if (url.endsWith(":fetchAvailableModels")) return Response.json(catalog);
    generationCalls++;
    return sse([{ text: "UNEXPECTED" }]);
  });
  const stale = models.getModel("antigravity", "gemini-3.8-flash")!;
  await credentials.modify("antigravity", async () => ({ ...credential, access: "different-access", email: "different@example.test" }));
  const response = await models.completeSimple(stale, { messages: [{ role: "user", content: "Synthetic stale account test", timestamp: 1 }] }, { reasoning: "low" });
  assert.equal(response.stopReason, "error");
  assert.match(response.errorMessage ?? "", /different account/);
  assert.equal(generationCalls, 0);
});

test("Pi's native catalog store restores offline and hides another account's snapshot", async () => {
  const { credentials, store } = await runtime(async input => String(input).endsWith(":loadCodeAssist")
    ? Response.json({ cloudaicompanionProject: "synthetic-project" }) : Response.json(catalog));
  const fresh = createModels({ credentials, modelsStore: store });
  let calls = 0;
  fresh.setProvider(antigravityProvider({ fetch: async () => { calls++; throw new Error("Network forbidden"); } }));
  const restored = await fresh.refresh({ providers: ["antigravity"], allowNetwork: false });
  assert.equal(restored.errors.size, 0);
  assert.equal(fresh.getModels("antigravity").length, 2);
  assert.equal((await fresh.getAvailable("antigravity")).length, 2);
  await credentials.modify("antigravity", async () => ({ ...credential, email: "other@example.test" }));
  assert.equal((await fresh.getAvailable("antigravity")).length, 0);
  await fresh.refresh({ providers: ["antigravity"], allowNetwork: false });
  assert.equal(fresh.getModels("antigravity").length, 0);
  assert.equal(calls, 0);
});
