import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createModels, InMemoryCredentialStore, type Provider, type ProviderAuthInteraction } from "@earendil-works/pi-ai";
import {
  AntigravityOAuthError, createAntigravityAuth, getApiKey, initializeAccount, loginAntigravity,
  OAUTH_AUTH_URL, OAUTH_CLIENT_ID, OAUTH_REDIRECT_URI, OAUTH_SCOPES, OAUTH_TOKEN_URL,
  parseApiKey, parseOAuthCallback, refreshAntigravityToken, type AntigravityOAuthCredential,
} from "../src/auth.ts";
import { DEFAULT_BASE_URL, type postJson } from "../src/client.ts";

const signal = () => new AbortController().signal;
const credential = (extra = {}): AntigravityOAuthCredential => ({ type: "oauth", access: "synthetic-access", refresh: "synthetic-refresh", expires: 9_000_000, projectId: "synthetic-project", email: "alice@example.test", ...extra });
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const token = (extra = {}) => ({ access_token: "synthetic-new-access", refresh_token: "synthetic-new-refresh", token_type: "Bearer", expires_in: 3600, ...extra });
const noTransport: typeof postJson = async () => { throw new Error("Unexpected network request"); };
function interaction(onUrl: (url: URL) => string | Promise<string>): ProviderAuthInteraction {
  let url: URL;
  return { signal: signal(), notify(event) { if (event.type === "auth_url") url = new URL(event.url); },
    async prompt() { return onUrl(url!); } };
}
const callback = (state: string, code = "synthetic-code") => `${OAUTH_REDIRECT_URI}?${new URLSearchParams({ state, code })}`;

test("credential bridge preserves the existing JSON contract and does not mutate OAuth data", () => {
  const input = Object.freeze(credential({ custom: "preserved" }));
  assert.deepEqual(parseApiKey(getApiKey(input)), { token: input.access, projectId: input.projectId, email: input.email });
  assert.equal(input.custom, "preserved");
  const legacy = parseApiKey(getApiKey(credential({ email: undefined })));
  assert.equal(legacy.token, "synthetic-access");
  assert.equal(legacy.projectId, "synthetic-project");
  assert.match(legacy.ownershipId ?? "", /^[a-f0-9]{64}$/);
  assert.deepEqual(parseApiKey(JSON.stringify({ token: "synthetic-access", projectId: "synthetic-project" })), { token: "synthetic-access", projectId: "synthetic-project" });
});

test("credential parsing rejects malformed and raw material without quoting secrets", () => {
  for (const value of [undefined, "raw-secret", '{"token":"unique-secret"', "[]", "null", '{"token":"x"}',
    JSON.stringify({ token: "x\r\nsecret", projectId: "p" }), JSON.stringify({ token: "x", projectId: { id: "p" } }),
    JSON.stringify({ token: "x", projectId: "p", email: "a\nb@example.test" }),
    JSON.stringify({ token: "x", projectId: "p", ownershipId: "invalid-marker" })]) {
    assert.throws(() => parseApiKey(value), error => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /unique-secret|raw-secret|\r|\n/);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
  assert.throws(() => getApiKey(credential({ projectId: undefined })));
  assert.throws(() => getApiKey(credential({ email: "invalid" })));
});

test("initialization sends only the consumer metadata on a single approved endpoint", async () => {
  const calls: unknown[] = [];
  const result = await initializeAccount("synthetic-access", { signal: signal(), postJson: async (...args) => {
    calls.push(args.slice(0, 4)); assert.ok(args[4] instanceof AbortSignal);
    return { cloudaicompanionProject: "synthetic-project", currentTier: { id: "consumer", name: "Personal subscription", secret: "not-returned" }, paidTier: { name: "Paid" } };
  } });
  assert.deepEqual(calls, [[DEFAULT_BASE_URL, "/v1internal:loadCodeAssist", "synthetic-access", { metadata: { ideType: "ANTIGRAVITY" } }]]);
  assert.deepEqual(result, { baseUrl: DEFAULT_BASE_URL, projectId: "synthetic-project", currentTier: { id: "consumer", name: "Personal subscription" }, paidTier: { name: "Paid" } });
});

test("initialization accepts the project object's id but refuses guessed aliases and onboarding", async () => {
  const result = await initializeAccount("synthetic-access", { postJson: async () => ({ cloudaicompanionProject: { id: "p" } }) });
  assert.equal(result.projectId, "p");
  for (const value of [null, {}, { projectId: "unverified-alias" }, { cloudaicompanionProject: { redacted: true } }, { allowedTiers: [{ id: "free" }] }]) {
    await assert.rejects(initializeAccount("synthetic-access", { postJson: async () => value }), /did not return/);
  }
});

test("initialization validates origins before transport and does not consume response routing hints", async () => {
  for (const baseUrl of ["http://daily-cloudcode-pa.googleapis.com", "https://evil.test", `${DEFAULT_BASE_URL}/v1`, `${DEFAULT_BASE_URL}?q=x`, "https://user@daily-cloudcode-pa.googleapis.com"]) {
    await assert.rejects(initializeAccount("synthetic-access", { baseUrl, postJson: noTransport }));
  }
  const result = await initializeAccount("synthetic-access", { postJson: async () => ({ cloudaicompanionProject: "p", baseUrl: "https://evil.test" }) });
  assert.equal(result.baseUrl, DEFAULT_BASE_URL);
});

test("initialization preserves structured transport errors and cancellation", async () => {
  const failure = Object.assign(new Error("synthetic HTTP failure"), { status: 403, details: { reason: "SYNTHETIC_DENIED" } });
  await assert.rejects(initializeAccount("synthetic-access", { postJson: async () => { throw failure; } }), error => error === failure);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(initializeAccount("synthetic-access", { signal: controller.signal, postJson: noTransport }), { name: "AbortError" });
  const late = new AbortController();
  await assert.rejects(initializeAccount("synthetic-access", { signal: late.signal, postJson: async () => {
    late.abort(); return { cloudaicompanionProject: "p" };
  } }), { name: "AbortError" });
});

test("manual callback validates the exact origin, path, independent state and single code", () => {
  assert.equal(parseOAuthCallback(callback("expected"), "expected"), "synthetic-code");
  for (const value of ["synthetic-code", "?code=x&state=expected", callback("wrong"), `${callback("expected")}&state=expected`, `${callback("expected")}&code=y`,
    callback("expected").replace("antigravity.google", "evil.test"), callback("expected").replace("https:", "http:"),
    `${callback("expected")}#fragment`, callback("expected").replace("oauth-callback", "other"),
    `${OAUTH_REDIRECT_URI}?state=expected&error=access_denied`, `${OAUTH_REDIRECT_URI}?state=expected&code=`]) {
    assert.throws(() => parseOAuthCallback(value, "expected"));
  }
});

test("native manual login uses statically checked CLI consumer parameters, PKCE, and Pi persistence shape", async () => {
  let authorization: URL;
  let seenVerifier = "";
  const calls: string[] = [];
  const ui = interaction(url => { authorization = url; return callback(url.searchParams.get("state")!); });
  const result = await loginAntigravity(ui, { now: () => 1000, fetch: async (url, init) => {
    calls.push(String(url)); assert.equal(init?.redirect, "error"); assert.ok(init?.signal);
    if (String(url) === OAUTH_TOKEN_URL) {
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get("client_id"), OAUTH_CLIENT_ID);
      assert.ok(body.get("client_secret")); assert.equal(body.get("grant_type"), "authorization_code");
      assert.equal(body.get("redirect_uri"), OAUTH_REDIRECT_URI); assert.equal(body.get("code"), "synthetic-code");
      seenVerifier = body.get("code_verifier")!;
      return json(token());
    }
    assert.equal(String(url), "https://www.googleapis.com/oauth2/v2/userinfo");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-new-access");
    return json({ email: "alice@example.test" });
  }, postJson: async (origin, path, access, payload) => {
    assert.equal(origin, DEFAULT_BASE_URL); assert.equal(path, "/v1internal:loadCodeAssist"); assert.equal(access, "synthetic-new-access");
    assert.deepEqual(payload, { metadata: { ideType: "ANTIGRAVITY" } });
    return { cloudaicompanionProject: "synthetic-project" };
  } });
  assert.equal(authorization!.origin + authorization!.pathname, OAUTH_AUTH_URL);
  assert.equal(authorization!.searchParams.get("scope"), OAUTH_SCOPES.join(" "));
  assert.equal(authorization!.searchParams.get("access_type"), "offline");
  assert.equal(authorization!.searchParams.get("prompt"), "consent");
  assert.equal(authorization!.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorization!.searchParams.get("code_challenge"), createHash("sha256").update(seenVerifier).digest("base64url"));
  assert.notEqual(authorization!.searchParams.get("state"), seenVerifier);
  assert.match(seenVerifier, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(result, { type: "oauth", access: "synthetic-new-access", refresh: "synthetic-new-refresh", expires: 3_601_000, projectId: "synthetic-project", email: "alice@example.test" });
  assert.equal(calls.length, 2);
});

test("login rejects state mismatch before any token exchange", async () => {
  await assert.rejects(loginAntigravity(interaction(() => callback("wrong")), {
    fetch: async () => { assert.fail("No exchange on bad state"); }, postJson: noTransport,
  }), /state mismatch/);
});

test("login cancellation and deadline stop a non-cooperative manual prompt", async () => {
  for (const timed of [false, true]) {
    const controller = new AbortController();
    const pending = loginAntigravity({ signal: controller.signal, notify() {}, prompt: async () => new Promise(() => {}) }, { loginTimeoutMs: timed ? 10 : 60_000 });
    if (!timed) controller.abort();
    // AbortSignal.timeout is unref'd; keep the test process alive while waiting.
    const keepAlive = setTimeout(() => {}, 1000);
    try { await assert.rejects(pending, { name: timed ? "TimeoutError" : "AbortError" }); }
    finally { clearTimeout(keepAlive); }
  }
});

test("token exchange validation refuses missing refresh, malformed JSON and invalid lifetimes", async () => {
  for (const data of [token({ refresh_token: undefined }), token({ expires_in: 0 }), token({ expires_in: "3600" }), token({ access_token: "x\nsecret" }), token({ token_type: "Basic" }), []]) {
    await assert.rejects(loginAntigravity(interaction(url => callback(url.searchParams.get("state")!)), { fetch: async () => json(data), postJson: noTransport }), /invalid|incomplete/i);
  }
  await assert.rejects(loginAntigravity(interaction(url => callback(url.searchParams.get("state")!)), { fetch: async () => new Response('{"secret":"unique-secret"'), postJson: noTransport }), error => {
    assert.ok(error instanceof Error); assert.doesNotMatch(error.message, /unique-secret/); return true;
  });
});

test("login fails closed for missing email or project rather than minting a UUID", async () => {
  for (const missingEmail of [true, false]) {
    let requests = 0;
    await assert.rejects(loginAntigravity(interaction(url => callback(url.searchParams.get("state")!)), {
      fetch: async () => json(requests++ === 0 ? token() : missingEmail ? {} : { email: "alice@example.test" }),
      postJson: async () => ({}),
    }), missingEmail ? /email/ : /project/);
  }
});

test("refresh preserves account and extras, supports rotation or omitted refresh token", async () => {
  for (const rotated of [true, false]) {
    const input = Object.freeze(credential({ custom: "retained" }));
    const result = await refreshAntigravityToken(input, signal(), { now: () => 2000, postJson: noTransport, fetch: async (url, init) => {
      assert.equal(url, OAUTH_TOKEN_URL); assert.equal(init?.redirect, "error");
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get("grant_type"), "refresh_token"); assert.equal(body.get("refresh_token"), input.refresh);
      assert.equal(body.has("code_verifier"), false);
      return json(token({ refresh_token: rotated ? "rotated-synthetic" : undefined }));
    } });
    assert.equal(result.refresh, rotated ? "rotated-synthetic" : input.refresh);
    assert.equal(result.email, input.email); assert.equal(result.projectId, input.projectId); assert.equal(result.custom, "retained");
    assert.equal(result.expires, 3_602_000); assert.equal(input.access, "synthetic-access");
  }
});

test("email-less ownership remains stable across repeated token rotation without mutating legacy credentials", async () => {
  const original = Object.freeze(credential({ email: undefined }));
  const ownershipId = parseApiKey(getApiKey(original)).ownershipId;
  let current = original;
  for (let index = 0; index < 3; index++) {
    current = await refreshAntigravityToken(current, signal(), { fetch: async () => json(token({ refresh_token: `rotated-refresh-${index}` })) });
    assert.equal(current.antigravityOwnershipId, ownershipId);
    assert.equal(parseApiKey(getApiKey(current)).ownershipId, ownershipId);
  }
  assert.equal(original.antigravityOwnershipId, undefined);
  assert.notEqual(parseApiKey(getApiKey(credential({ email: undefined, refresh: "different-account-refresh" }))).ownershipId, ownershipId);
  await assert.rejects(refreshAntigravityToken(credential({ email: undefined, antigravityOwnershipId: "invalid" }), signal(), { fetch: async () => { assert.fail("Invalid ownership must fail before rotation"); } }), /credentials/);
});

test("refresh rejects uninitialized credentials before rotation and honors abort", async () => {
  const fetchNever: typeof fetch = async () => { assert.fail("Unexpected token exchange"); };
  await assert.rejects(refreshAntigravityToken(credential({ projectId: undefined }), signal(), { fetch: fetchNever }), /credentials/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(refreshAntigravityToken(credential(), controller.signal, { fetch: fetchNever }), { name: "AbortError" });
});

test("OAuth errors preserve HTTP status and safe code without provider body or parser cause", async () => {
  for (const errorCode of ["invalid_grant", "unique-secret"]) {
    await assert.rejects(refreshAntigravityToken(credential(), signal(), { fetch: async () => json({ error: errorCode, error_description: "unique-secret", access_token: "unique-secret" }, 400) }), error => {
      assert.ok(error instanceof AntigravityOAuthError); assert.equal(error.status, 400);
      assert.equal(error.code, errorCode === "invalid_grant" ? errorCode : undefined);
      assert.doesNotMatch(String(error), /unique-secret/); assert.equal(error.cause, undefined); return true;
    });
  }
});

test("OAuth requests forward cancellation through fetch and reject late responses", async () => {
  const controller = new AbortController();
  await assert.rejects(refreshAntigravityToken(credential(), controller.signal, { fetch: async (_url, init) => {
    assert.ok(init?.signal); controller.abort(); return json(token());
  } }), { name: "AbortError" });
});

test("native Models serializes refresh and stores rotated credentials without a private auth registry", async () => {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("antigravity", async () => credential({ expires: 0 }));
  let count = 0;
  const auth = createAntigravityAuth({ fetch: async () => { count++; await new Promise(resolve => setTimeout(resolve, 10)); return json(token()); }, postJson: noTransport });
  const provider: Provider = { id: "antigravity", name: "Antigravity", auth, getModels: () => [], stream() { throw new Error("Not used"); }, streamSimple() { throw new Error("Not used"); } };
  const models = createModels({ credentials }); models.setProvider(provider);
  const [a, b] = await Promise.all([models.getAuth("antigravity"), models.getAuth("antigravity")]);
  assert.equal(count, 1); assert.deepEqual(a, b); assert.equal(parseApiKey(a?.auth.apiKey).token, "synthetic-new-access");
  const stored = await credentials.read("antigravity");
  assert.equal(stored?.type, "oauth");
  assert.ok(stored?.type === "oauth");
  assert.equal(stored.refresh, "synthetic-new-refresh");
});

test("native failed refresh leaves the original credential intact", async () => {
  const credentials = new InMemoryCredentialStore(); const original = credential({ expires: 0 });
  await credentials.modify("antigravity", async () => original);
  const auth = createAntigravityAuth({ fetch: async () => json({ error: "invalid_grant" }, 400) });
  const models = createModels({ credentials }); models.setProvider({ id: "antigravity", name: "Antigravity", auth, getModels: () => [], stream() { throw new Error("Not used"); }, streamSimple() { throw new Error("Not used"); } });
  await assert.rejects(models.getAuth("antigravity"), /OAuth refresh failed/);
  assert.deepEqual(await credentials.read("antigravity"), original);
});
