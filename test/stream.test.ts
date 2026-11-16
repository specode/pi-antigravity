import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessageEvent, Model } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { CLIENT_USER_AGENT, DEFAULT_BASE_URL } from "../src/client.ts";
import { streamAntigravity, type AntigravityStreamDependencies, type AntigravityStreamOptions } from "../src/stream.ts";

const model: Model<"antigravity"> = {
  id: "synthetic-flash", name: "Synthetic Flash", api: "antigravity", provider: "antigravity",
  baseUrl: DEFAULT_BASE_URL, reasoning: true, input: ["text"], contextWindow: 10000, maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const context = normalizeContext({ messages: [] });
const encoder = new TextEncoder();
const event = (parts: unknown[] = [], finishReason?: string, extra = {}) => ({
  response: { candidates: [{ content: { parts }, ...(finishReason ? { finishReason } : {}) }], ...extra },
});
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const complete = frame(event([{ text: "OK" }], "STOP"));

function response(text: string, split = false) {
  const bytes = encoder.encode(text);
  const chunks = split ? Array.from(bytes, (b) => new Uint8Array([b])) : [bytes];
  return new Response(new ReadableStream<Uint8Array>({
    pull(c) { const chunk = chunks.shift(); if (chunk) c.enqueue(chunk); else c.close(); },
  }), { headers: { "Content-Type": "text/event-stream" } });
}
function dependencies(fetch: typeof globalThis.fetch): AntigravityStreamDependencies {
  return { fetch, buildPayload: () => ({ synthetic: true }), resolveCredentials: () => ({ token: "synthetic-token" }) };
}
async function run(text: string, options: AntigravityStreamOptions = {}, split = false) {
  const s = streamAntigravity(model, context, options, dependencies(async () => response(text, split)));
  const events: AssistantMessageEvent[] = [];
  for await (const e of s) events.push(e);
  const result = await s.result();
  assertLifecycle(events);
  return { events, result };
}
function assertLifecycle(events: AssistantMessageEvent[]) {
  assert.equal(events.filter((e) => e.type === "done" || e.type === "error").length, 1);
  assert.ok(["done", "error"].includes(events.at(-1)!.type));
  const open = new Map<number, string>();
  let started = false;
  for (const e of events) {
    if (e.type === "start") { assert.equal(started, false); started = true; }
    else if (e.type !== "error") assert.equal(started, true);
    if ("contentIndex" in e) {
      const kind = e.type.split("_")[0]!;
      if (e.type.endsWith("_start")) { assert.equal(open.has(e.contentIndex), false); open.set(e.contentIndex, kind); }
      else { assert.equal(open.get(e.contentIndex), kind); if (e.type.endsWith("_end")) open.delete(e.contentIndex); }
    }
  }
  assert.equal(open.size, 0);
}

test("streams split UTF-8, CRLF, CR, BOM, comments and multiline data", async () => {
  const text = '\uFEFF: heartbeat\r\nid: 1\r\nevent: message\r\nretry: 10\r\n' +
    'data: {"response":\r\ndata: {"candidates":[{"content":{"parts":[{"text":"你好🌍"}]},"finishReason":"STOP"}]}}\r\n\r\n';
  const { result } = await run(text, {}, true);
  assert.equal(result.stopReason, "stop");
  assert.deepEqual(result.content, [{ type: "text", text: "你好🌍" }]);
  assert.equal((await run(complete.replaceAll("\n", "\r"), {}, true)).result.stopReason, "stop");
});

test("preserves text, thinking, empty final signatures and upstream provenance", async () => {
  const text = frame(event([{ text: "Reason", thought: true, thoughtSignature: "dGhpbms=" }])) +
    frame(event([{ text: "ing", thought: true }])) + frame(event([{ text: "Answer" }])) +
    frame({ ...event([{ text: "", thoughtSignature: "ZmluYWw=" }], "STOP", {
      responseId: "upstream-id", modelVersion: "actual-served-model",
    }), traceId: "trace", metadata: { synthetic: true } });
  const { result, events } = await run(text);
  assert.deepEqual(result.content, [
    { type: "thinking", thinking: "Reasoning", thinkingSignature: "dGhpbms=" },
    { type: "text", text: "Answer" },
    { type: "text", text: "", textSignature: "ZmluYWw=" },
  ]);
  assert.equal(result.model, model.id);
  assert.equal(result.responseModel, "actual-served-model");
  assert.equal(result.responseId, "upstream-id");
  assert.equal(result.diagnostics?.[0]?.details?.traceId, "trace");
  assert.equal(events.filter((e) => e.type === "thinking_end").length, 1);
});

test("preserves distinct signed parts within a frame and signed thinking-to-text boundaries", async () => {
  const { result } = await run(frame(event([
    { text: "first", thoughtSignature: "Zmlyc3Q=" },
    { text: "second", thoughtSignature: "c2Vjb25k" },
    { text: "reason", thought: true, thoughtSignature: "dGhpbms=" },
    { text: "answer", thoughtSignature: "YW5zd2Vy" },
    { text: "", thoughtSignature: "ZW1wdHk=" },
  ], "STOP")));
  assert.deepEqual(result.content, [
    { type: "text", text: "first", textSignature: "Zmlyc3Q=" },
    { type: "text", text: "second", textSignature: "c2Vjb25k" },
    { type: "thinking", thinking: "reason", thinkingSignature: "dGhpbms=" },
    { type: "text", text: "answer", textSignature: "YW5zd2Vy" },
    { type: "text", text: "", textSignature: "ZW1wdHk=" },
  ]);
});

test("keeps a signature-only empty text block instead of moving its signature to a tool", async () => {
  const { result } = await run(frame(event([
    { functionCall: { id: "call-one", name: "read", args: { path: "synthetic.txt" } }, thoughtSignature: "dG9vbA==" },
    { text: "", thoughtSignature: "ZW1wdHk=" },
  ], "STOP")));
  assert.equal(result.stopReason, "toolUse");
  assert.deepEqual(result.content, [
    { type: "toolCall", id: "call-one", name: "read", arguments: { path: "synthetic.txt" }, thoughtSignature: "dG9vbA==" },
    { type: "text", text: "", textSignature: "ZW1wdHk=" },
  ]);
});

test("retains parallel tool IDs, nested arguments and one complete JSON delta per call", async () => {
  const args = { nested: { list: [1, null, false, "你好"] }, empty: {} };
  const { result, events } = await run(frame(event([
    { functionCall: { id: "a", name: "first", args } },
    { functionCall: { id: "b", name: "second", args: {} } },
    { functionCall: { name: "third" } },
  ], "STOP")));
  assert.equal(result.stopReason, "toolUse");
  assert.deepEqual(result.content[0], { type: "toolCall", id: "a", name: "first", arguments: args });
  const deltas = events.filter((e) => e.type === "toolcall_delta");
  assert.deepEqual(deltas.map((e) => JSON.parse(e.delta)), [args, {}, {}]);
  assert.equal(new Set(result.content.filter((b) => b.type === "toolCall").map((b) => b.id)).size, 3);
});

test("usage is cumulative, separates cached input, includes thinking in output, and keeps trailing usage", async () => {
  const counters = { promptTokenCount: 100, candidatesTokenCount: 10, cachedContentTokenCount: 40, thoughtsTokenCount: 5, totalTokenCount: 115 };
  const text = frame(event([{ text: "OK" }], undefined, { usageMetadata: counters })) +
    frame(event([], "STOP", { usageMetadata: counters })) +
    frame({ response: { usageMetadata: { candidatesTokenCount: 12, totalTokenCount: 117 } } });
  const { result } = await run(text);
  assert.deepEqual(result.usage, {
    input: 60, output: 17, cacheRead: 40, cacheWrite: 0, reasoning: 5, totalTokens: 117,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, totalFromProvider: false },
  });
  const noThoughts = (await run(frame(event([], "STOP", { usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } })))).result;
  assert.equal(noThoughts.usage.reasoning, undefined);
  assert.equal(noThoughts.usage.totalTokens, 5);
});

test("clamps cached tokens when they exceed prompt tokens instead of aborting the stream", async () => {
  const clamped = (await run(
    frame(event([{ text: "OK" }], "STOP", { usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 120, candidatesTokenCount: 5 } })),
  )).result;
  assert.equal(clamped.stopReason, "stop");
  assert.equal(clamped.usage.input, 0);
  assert.equal(clamped.usage.cacheRead, 100);
  assert.equal(clamped.usage.output, 5);
  assert.deepEqual(clamped.diagnostics?.find((d) => d.type === "antigravity.usage_clamped")?.details, {
    promptTokenCount: 100,
    cachedContentTokenCount: 120,
  });

  const recovered = (await run(
    frame(event([{ text: "OK" }], undefined, { usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 120 } })) +
    frame(event([], "STOP", { usageMetadata: { promptTokenCount: 150, candidatesTokenCount: 8 } })),
  )).result;
  assert.equal(recovered.stopReason, "stop");
  assert.equal(recovered.usage.input, 30);
  assert.equal(recovered.usage.cacheRead, 120);
  assert.equal(recovered.usage.output, 8);
});

test("honors async payload replacement and hooks before body consumption and normalization", async () => {
  const order: string[] = [];
  let optionsSeen: AntigravityStreamOptions | undefined;
  const replacement = { replaced: true };
  const deps = dependencies(async (url, init) => {
    order.push("fetch");
    assert.equal(url, `${DEFAULT_BASE_URL}/v1internal:streamGenerateContent?alt=sse`);
    assert.equal(init?.redirect, "error");
    assert.equal(init?.body, JSON.stringify(replacement));
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("user-agent"), CLIENT_USER_AGENT);
    assert.equal(headers.get("authorization"), "Bearer synthetic-token");
    assert.equal(headers.get("x-synthetic"), "yes");
    return response(complete);
  });
  deps.buildPayload = (_model, _context, opts) => { optionsSeen = opts; order.push("build"); return { original: true }; };
  const s = streamAntigravity(model, context, {
    env: { SYNTHETIC: "scoped" }, headers: { "x-synthetic": "yes" },
    onPayload: async (_p, m) => { assert.equal(m, model); order.push("payload"); return replacement; },
    onResponse: async (r, m) => { assert.equal(m, model); assert.equal(r.status, 200); order.push("response"); },
    onProviderStreamEvent: async (raw, m) => { assert.equal(m, model); assert.deepEqual(raw, event([{ text: "OK" }], "STOP")); order.push("raw"); },
  }, deps);
  const events: AssistantMessageEvent[] = [];
  for await (const e of s) { events.push(e); if (e.type === "text_delta") order.push("normalized"); }
  assertLifecycle(events);
  assert.deepEqual(order, ["build", "payload", "fetch", "response", "raw", "normalized"]);
  assert.deepEqual(optionsSeen?.env, { SYNTHETIC: "scoped" });
  assert.equal(optionsSeen?.signal?.aborted, true); // Internal resources have been shut down.
});

test("payload undefined return retains in-place edits; explicit null is sent", async () => {
  for (const explicitNull of [false, true]) {
    let sent: unknown;
    const s = streamAntigravity(model, context, { onPayload(p) {
      (p as Record<string, unknown>).changed = true;
      return explicitNull ? null : undefined;
    } }, dependencies(async (_url, init) => { sent = JSON.parse(init!.body as string); return response(complete); }));
    assert.equal((await s.result()).stopReason, "stop");
    assert.deepEqual(sent, explicitNull ? null : { synthetic: true, changed: true });
  }
});

for (const [name, text, pattern] of [
  ["empty body", "", /without a finish reason/],
  ["missing finish", frame(event([{ text: "partial" }])), /without a finish reason/],
  ["malformed JSON", frame(event([{ text: "partial" }])) + "data: {invalid}\n\n", /invalid JSON/],
  ["truncated frame after STOP", complete + "data: {", /incomplete frame/],
  ["unterminated frame", complete.trimEnd(), /incomplete frame/],
  ["DONE without finish", "data: [DONE]\n\n", /without a finish reason/],
  ["unsupported part", frame(event([{ inlineData: { data: "AAAA" } }], "STOP")), /Unsupported.*part/],
  ["invalid args", frame(event([{ functionCall: { name: "bad", args: "{broken" } }], "STOP")), /functionCall.args/],
  ["duplicate ID", frame(event([{ functionCall: { name: "a", id: "same" } }, { functionCall: { name: "b", id: "same" } }], "STOP")), /duplicate.*ID/],
  ["blocked finish", frame(event([{ text: "partial" }], "SAFETY")), /SAFETY/],
  ["invalid counter", frame(event([], "STOP", { usageMetadata: { thoughtsTokenCount: -1 } })), /usage counter/],
  ["conflicting finish", complete + frame(event([], "MAX_TOKENS")), /Conflicting/],
  ["text after finish", complete + frame(event([{ text: "extra" }])), /after the finish/],
] as const) {
  test(`fails closed and balances blocks for ${name}`, async () => {
    const { result } = await run(text);
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage!, pattern);
  });
}

test("accepts a valid empty response and MAX_TOKENS and optional DONE", async () => {
  assert.equal((await run(frame(event([], "STOP")))).result.stopReason, "stop");
  assert.equal((await run(frame(event([{ text: "" }], "STOP")))).result.content.length, 1);
  assert.equal((await run(frame(event([{ text: "partial" }], "MAX_TOKENS")))).result.stopReason, "length");
  assert.equal((await run(complete + "data: [DONE]\n\n")).result.stopReason, "stop");
});

test("preserves structured HTTP ErrorInfo and RetryInfo without guessed quota classification or retries", async () => {
  const body = { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "quota wording is not proof",
    details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "CAPACITY", domain: "synthetic" },
      { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "3s" }] } };
  let calls = 0;
  let responseHook = false;
  const s = streamAntigravity(model, context, { maxRetries: 50, onResponse: () => { responseHook = true; } }, dependencies(async () => {
    calls++; return new Response(JSON.stringify(body), { status: 429, headers: { "retry-after": "3" } });
  }));
  const events: AssistantMessageEvent[] = [];
  for await (const e of s) events.push(e);
  const result = await s.result();
  assertLifecycle(events);
  assert.equal(events.length, 1);
  assert.equal(calls, 1);
  assert.equal(responseHook, true);
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage!, /429/);
  assert.deepEqual(result.diagnostics?.at(-1)?.details, { status: 429, body, retryAfter: "3" });
});

test("stream error after partial output keeps original structured evidence", async () => {
  const body = { error: { code: 503, status: "UNAVAILABLE", details: [{ reason: "BACKEND_BUSY" }] } };
  const { result } = await run(frame(event([{ text: "partial" }])) + frame(body));
  assert.equal(result.stopReason, "error");
  assert.deepEqual(result.content, [{ type: "text", text: "partial" }]);
  assert.deepEqual(result.diagnostics?.at(-1)?.details?.body, body);
});

test("rejects invalid UTF-8 and oversized SSE frames", async () => {
  const deps = dependencies(async () => new Response(new Uint8Array([0xff]), { headers: { "Content-Type": "text/event-stream" } }));
  assert.equal((await streamAntigravity(model, context, {}, deps).result()).stopReason, "error");
  assert.match((await run("data: " + "x".repeat(4 * 1024 * 1024))).result.errorMessage!, /size limit/);
});

test("pre-aborted requests never build or fetch", async () => {
  const controller = new AbortController(); controller.abort();
  const fail = () => { throw new Error("must not run"); };
  const s = streamAntigravity(model, context, { signal: controller.signal }, { buildPayload: fail, resolveCredentials: fail, fetch: fail });
  const events: AssistantMessageEvent[] = [];
  for await (const e of s) events.push(e);
  assertLifecycle(events);
  assert.equal(events.length, 1);
  assert.equal((await s.result()).stopReason, "aborted");
});

function stalledResponse(prefix = "") {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(c) { if (prefix) c.enqueue(encoder.encode(prefix)); },
    cancel() { cancelled = true; },
  });
  return { body, get cancelled() { return cancelled; }, response: new Response(body, { headers: { "Content-Type": "text/event-stream" } }) };
}

test("abort during read cancels and unlocks the body with one terminal event", async () => {
  const stalled = stalledResponse(frame(event([{ text: "partial" }])));
  const controller = new AbortController();
  let fetchSignal: AbortSignal | undefined;
  const s = streamAntigravity(model, context, { signal: controller.signal }, dependencies(async (_u, init) => {
    fetchSignal = init!.signal!; return stalled.response;
  }));
  const events: AssistantMessageEvent[] = [];
  for await (const e of s) { events.push(e); if (e.type === "text_delta") controller.abort(); }
  assertLifecycle(events);
  assert.equal((await s.result()).stopReason, "aborted");
  assert.equal(stalled.cancelled, true);
  assert.equal(stalled.body.locked, false);
  assert.equal(fetchSignal?.aborted, true);
});

test("header timeout aborts a non-cooperative fetch and cancels its late body", async () => {
  let resolve!: (r: Response) => void;
  let signal: AbortSignal | undefined;
  const s = streamAntigravity(model, context, { headTimeoutMs: 10 }, dependencies((_u, init) => {
    signal = init!.signal!; return new Promise((r) => { resolve = r; });
  }));
  const result = await s.result();
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage!, /response-header timeout/);
  assert.equal(signal?.aborted, true);
  const stalled = stalledResponse(); resolve(stalled.response);
  await new Promise((r) => setImmediate(r));
  assert.equal(stalled.cancelled, true);
});

test("idle timeout is distinct, cancels and unlocks even after partial output", async () => {
  const stalled = stalledResponse(frame(event([{ text: "partial" }])));
  const s = streamAntigravity(model, context, { headTimeoutMs: 1000, idleTimeoutMs: 10 }, dependencies(async () => stalled.response));
  const events: AssistantMessageEvent[] = [];
  for await (const e of s) events.push(e);
  assertLifecycle(events);
  assert.match((await s.result()).errorMessage!, /body-idle timeout/);
  assert.equal(stalled.cancelled, true);
  assert.equal(stalled.body.locked, false);
});

test("timeoutMs is honored as a fallback and error bodies have idle deadlines", async () => {
  const stalled = stalledResponse();
  const errorResponse = new Response(stalled.body, { status: 503 });
  const s = streamAntigravity(model, context, { timeoutMs: 10 }, dependencies(async () => errorResponse));
  assert.match((await s.result()).errorMessage!, /body-idle timeout/);
  assert.equal(stalled.cancelled, true);
});

test("slow observer hooks do not consume the network idle deadline", async () => {
  const { result } = await run(complete, { idleTimeoutMs: 10, onProviderStreamEvent: async () => {
    await new Promise((r) => setTimeout(r, 30));
  } });
  assert.equal(result.stopReason, "stop");
});

for (const hook of ["onPayload", "onResponse", "onProviderStreamEvent"] as const) {
  test(`hook failure in ${hook} produces one error and cleans up`, async () => {
    const stalled = stalledResponse(complete);
    let fetched = false;
    const s = streamAntigravity(model, context, { [hook]: async () => { throw new Error("synthetic hook failure"); } }, dependencies(async () => {
      fetched = true; return stalled.response;
    }));
    const events: AssistantMessageEvent[] = [];
    for await (const e of s) events.push(e);
    assertLifecycle(events);
    assert.match((await s.result()).errorMessage!, /synthetic hook failure/);
    assert.equal(fetched, hook !== "onPayload");
    if (fetched) { assert.equal(stalled.cancelled, true); assert.equal(stalled.body.locked, false); }
  });
}

test("abort interrupts stalled hooks and cleans up without retry", async () => {
  const controller = new AbortController();
  const stalled = stalledResponse(complete);
  const s = streamAntigravity(model, context, {
    signal: controller.signal,
    onProviderStreamEvent: () => { controller.abort(); return new Promise(() => {}); },
  }, dependencies(async () => stalled.response));
  assert.equal((await s.result()).stopReason, "aborted");
  assert.equal(stalled.cancelled, true);
  assert.equal(stalled.body.locked, false);
});

test("official-origin validation occurs before fetch and redirects are never followed", async () => {
  let calls = 0;
  const deps = dependencies(async () => { calls++; return response(complete); });
  deps.resolveCredentials = () => ({ token: "synthetic", baseUrl: "https://untrusted.invalid" });
  assert.equal((await streamAntigravity(model, context, {}, deps).result()).stopReason, "error");
  assert.equal(calls, 0);
});

test("options.fetch overrides dependencies.fetch; no actual served model is invented", async () => {
  const deps = dependencies(async () => { throw new Error("wrong fetch"); });
  const result = await streamAntigravity(model, context, { fetch: async () => response(complete) }, deps).result();
  assert.equal(result.stopReason, "stop");
  assert.equal(result.responseModel, undefined);
});

test("read failure after partial output preserves content and balances the open block", async () => {
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (pulls++ === 0) c.enqueue(encoder.encode(frame(event([{ text: "partial" }]))));
      else c.error(new Error("synthetic connection reset"));
    },
  });
  const s = streamAntigravity(model, context, {}, dependencies(async () => new Response(body, {
    headers: { "Content-Type": "text/event-stream" },
  })));
  const events: AssistantMessageEvent[] = [];
  for await (const e of s) events.push(e);
  assertLifecycle(events);
  const result = await s.result();
  assert.match(result.errorMessage!, /synthetic connection reset/);
  assert.deepEqual(result.content, [{ type: "text", text: "partial" }]);
  assert.equal(body.locked, false);
});

test("a finish reason does not hide a subsequent idle timeout or truncated UTF-8", async () => {
  const stalled = stalledResponse(complete);
  const result = await streamAntigravity(model, context, { idleTimeoutMs: 10 }, dependencies(async () => stalled.response)).result();
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage!, /body-idle timeout/);
  const data = encoder.encode(complete);
  const invalid = new Uint8Array([...data, 0xe4, 0xb8]);
  const truncated = await streamAntigravity(model, context, {}, dependencies(async () => new Response(invalid, {
    headers: { "Content-Type": "text/event-stream" },
  }))).result();
  assert.equal(truncated.stopReason, "error");
});

for (const stage of ["credentials", "payload", "headers"] as const) {
  test(`abort interrupts a non-cooperative ${stage} wait`, async () => {
    const controller = new AbortController();
    let signal: AbortSignal | undefined;
    const waiting = () => { controller.abort(); return new Promise<never>(() => {}); };
    const deps = dependencies(async (_u, init) => { signal = init!.signal!; return stage === "headers" ? waiting() : response(complete); });
    if (stage === "credentials") deps.resolveCredentials = (_m, opts) => { signal = opts.signal; return waiting(); };
    if (stage === "payload") deps.buildPayload = (_m, _c, opts) => { signal = opts.signal; return waiting(); };
    const s = streamAntigravity(model, context, { signal: controller.signal }, deps);
    assert.equal((await s.result()).stopReason, "aborted");
    assert.equal(signal?.aborted, true);
  });
}

test("a non-settling cancellation promise cannot retain the reader or terminal result", async () => {
  let cancelCalled = false;
  const body = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(encoder.encode(complete + "data: [DONE]\n\n")); },
    cancel() { cancelCalled = true; return new Promise(() => {}); },
  });
  const result = await streamAntigravity(model, context, {}, dependencies(async () => new Response(body, {
    headers: { "Content-Type": "text/event-stream" },
  }))).result();
  assert.equal(result.stopReason, "stop");
  assert.equal(cancelCalled, true);
  assert.equal(body.locked, false);
});

test("concurrent streams have independent cancellation and tool identities", async () => {
  const controller = new AbortController();
  const stalled = stalledResponse();
  const aborted = streamAntigravity(model, context, { signal: controller.signal }, dependencies(async () => stalled.response));
  const completed = streamAntigravity(model, context, {}, dependencies(async () => response(frame(event([
    { functionCall: { name: "synthetic" } },
  ], "STOP")))));
  controller.abort();
  assert.equal((await aborted.result()).stopReason, "aborted");
  assert.equal((await completed.result()).stopReason, "toolUse");
});

test("HTTP redirects, wrong content type and missing bodies fail before start", async () => {
  for (const res of [
    new Response(null, { status: 302, headers: { location: "https://untrusted.invalid" } }),
    new Response("{}", { headers: { "Content-Type": "application/json" } }),
    new Response(null, { headers: { "Content-Type": "text/event-stream" } }),
  ]) {
    const s = streamAntigravity(model, context, {}, dependencies(async (_u, init) => {
      assert.equal(init?.redirect, "error"); return res;
    }));
    const events: AssistantMessageEvent[] = [];
    for await (const e of s) events.push(e);
    assertLifecycle(events);
    assert.equal(events.length, 1);
    assert.equal((await s.result()).stopReason, "error");
  }
});

test("rejects invalid timeout values before fetching", async () => {
  for (const value of [0, -1, NaN, Infinity, 2 ** 31]) {
    const s = streamAntigravity(model, context, { idleTimeoutMs: value }, dependencies(async () => {
      assert.fail("fetch should not run");
    }));
    assert.equal((await s.result()).stopReason, "error");
    assert.match((await s.result()).errorMessage!, /timeouts/);
  }
});

test("successful DONE cancels an otherwise never-ending body and releases its reader", async () => {
  const stalled = stalledResponse(complete + "data: [DONE]\n\n");
  const result = await streamAntigravity(model, context, {}, dependencies(async () => stalled.response)).result();
  assert.equal(result.stopReason, "stop");
  assert.equal(stalled.cancelled, true);
  assert.equal(stalled.body.locked, false);
});
