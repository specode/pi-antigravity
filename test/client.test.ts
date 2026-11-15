import assert from "node:assert/strict";
import test from "node:test";
import { AntigravityHttpError, assertOfficialBaseUrl, CLIENT_USER_AGENT, DEFAULT_BASE_URL, postJson, readBoundedBody } from "../src/client.ts";

test("only approved HTTPS origins may receive credentials", async () => {
  assert.equal(assertOfficialBaseUrl(`${DEFAULT_BASE_URL}/`), DEFAULT_BASE_URL);
  for (const url of ["http://daily-cloudcode-pa.googleapis.com", `${DEFAULT_BASE_URL}/proxy`, `${DEFAULT_BASE_URL}?x=y`, "https://user:password@cloudcode-pa.googleapis.com", "https://cloudcode-pa.googleapis.com.evil.test", "https://evil.test", `${DEFAULT_BASE_URL}#x`]) {
    let calls = 0;
    await assert.rejects(postJson(url, "/v1internal:fetchAvailableModels", "secret", {}, undefined, { fetch: async () => { calls++; return Response.json({}); } }), /approved official/);
    assert.equal(calls, 0);
  }
});

test("JSON operations use CLI identity and reject redirects without retries", async () => {
  let calls = 0;
  const result = await postJson(DEFAULT_BASE_URL, "/v1internal:loadCodeAssist", "synthetic", { probe: true }, undefined, {
    fetch: async (url, init) => {
      calls++;
      assert.equal(url, `${DEFAULT_BASE_URL}/v1internal:loadCodeAssist`);
      assert.equal(init?.redirect, "error");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("Authorization"), "Bearer synthetic");
      assert.equal(headers.get("User-Agent"), CLIENT_USER_AGENT);
      return Response.json({ ok: true });
    },
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 1);
  await assert.rejects(postJson(DEFAULT_BASE_URL, "//evil.test", "secret", {}), /operation path/);
});

test("HTTP failures preserve structured ErrorInfo and status", async () => {
  const details = { error: { code: 429, status: "RESOURCE_EXHAUSTED", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "RATE_LIMIT_EXCEEDED" }] } };
  await assert.rejects(postJson(DEFAULT_BASE_URL, "/v1internal:fetchAvailableModels", "synthetic", {}, undefined, {
    fetch: async () => Response.json(details, { status: 429 }),
  }), (error: unknown) => {
    assert.ok(error instanceof AntigravityHttpError);
    assert.equal(error.status, 429);
    assert.deepEqual(error.details, details);
    assert.match(error.message, /RATE_LIMIT_EXCEEDED/);
    return true;
  });
});

test("bounded body rejects oversized and invalid UTF-8 responses", async () => {
  await assert.rejects(readBoundedBody(new Response("12345"), 4), /size limit/);
  await assert.rejects(readBoundedBody(new Response(new Uint8Array([0xff])), 4));
});

test("abort cancels a stalled body and rejects rather than resolving empty", async () => {
  let cancelled = false;
  const controller = new AbortController();
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const promise = readBoundedBody(new Response(body), 100, controller.signal);
  controller.abort();
  await assert.rejects(promise, { name: "AbortError" });
  assert.equal(cancelled, true);
});

test("bounded body abort does not await a non-settling source cancellation", async () => {
  const controller = new AbortController();
  const body = new ReadableStream<Uint8Array>({ cancel: () => new Promise<void>(() => {}) });
  const response = new Response(body);
  const pending = readBoundedBody(response, 100, controller.signal);
  controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await assert.rejects(Promise.race([pending, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Cancellation stalled")), 100);
    })]), { name: "AbortError" });
    assert.equal(body.locked, false);
  } finally { clearTimeout(timer); }
});

test("JSON timeout also covers the response body", async () => {
  let cancelled = false;
  const promise = postJson(DEFAULT_BASE_URL, "/v1internal:loadCodeAssist", "synthetic", {}, undefined, {
    timeoutMs: 10,
    fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })),
  });
  // AbortSignal.timeout is unref'd; keep the isolated test process alive.
  const timer = setTimeout(() => {}, 1000);
  try { await assert.rejects(promise, { name: "TimeoutError" }); }
  finally { clearTimeout(timer); }
  assert.equal(cancelled, true);
});
