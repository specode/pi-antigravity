import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { OAuthCredential, OAuthCredentials, ProviderAuth, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { assertOfficialBaseUrl, CLIENT_USER_AGENT, DEFAULT_BASE_URL, postJson, readBoundedBody } from "./client.ts";

/** Existing Pi auth.json shape. Pi alone owns storage and refresh locking. */
export interface AntigravityOAuthCredential extends OAuthCredential {
  projectId: string;
  email?: string;
  /** Provider-local fallback identity, retained when a refresh token rotates. */
  antigravityOwnershipId?: string;
}

/** Public credential bridge consumed by chat, usage and image integrations. */
export interface AntigravityApiKey {
  token: string;
  projectId: string;
  email?: string;
  /** Optional additive bridge metadata; never a replacement bearer-token format. */
  ownershipId?: string;
}

export interface AccountInitialization {
  baseUrl: string;
  projectId: string;
  currentTier?: { id?: string; name?: string };
  paidTier?: { id?: string; name?: string };
}

export interface InitializeAccountOptions {
  baseUrl?: string;
  signal?: AbortSignal;
  /** Injectable transport for offline tests; production uses the shared client. */
  postJson?: typeof postJson;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function wireString(value: unknown): value is string {
  return typeof value === "string" && value.length <= 8192 && /^[\x21-\x7e]+$/.test(value);
}

function email(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(value)
    ? value : undefined;
}

function invalidCredentials(): Error {
  // Never include JSON parser errors: they can quote access tokens.
  return new Error("Invalid Antigravity credentials: expected token and Cloud Code Assist projectId.");
}

/** Strict JSON bridge; raw bearer tokens and fabricated project IDs are not accepted. */
export function parseApiKey(value: string | undefined): AntigravityApiKey {
  let parsed: unknown;
  try { parsed = JSON.parse(value ?? ""); } catch { throw invalidCredentials(); }
  const data = record(parsed);
  if (!data || !wireString(data.token) || !wireString(data.projectId)) throw invalidCredentials();
  if (data.email !== undefined && !email(data.email)) throw invalidCredentials();
  if (data.ownershipId !== undefined && !validOwnershipId(data.ownershipId)) throw invalidCredentials();
  return { token: data.token, projectId: data.projectId, ...(email(data.email) ? { email: email(data.email) } : {}),
    ...(validOwnershipId(data.ownershipId) ? { ownershipId: data.ownershipId } : {}) };
}

function validOwnershipId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

/** Derive once from the old refresh token; retain the marker before rotating it. */
function fallbackOwnershipId(credential: OAuthCredentials): string {
  const existing = credential.antigravityOwnershipId;
  if (existing !== undefined) {
    if (!validOwnershipId(existing)) throw invalidCredentials();
    return existing;
  }
  if (!wireString(credential.refresh)) throw invalidCredentials();
  return createHash("sha256").update("pi-antigravity/ownership/v1\0").update(credential.refresh).digest("hex");
}

/** Pure serialization of existing Pi OAuth credentials; does not mutate or persist. */
export function getApiKey(credential: OAuthCredentials): string {
  if (!wireString(credential.access) || !wireString(credential.projectId)) throw invalidCredentials();
  if (credential.email !== undefined && !email(credential.email)) throw invalidCredentials();
  return JSON.stringify({ token: credential.access, projectId: credential.projectId,
    ...(email(credential.email) ? { email: email(credential.email) } : { ownershipId: fallbackOwnershipId(credential) }) });
}

function tier(value: unknown): AccountInitialization["currentTier"] {
  const data = record(value);
  if (!data) return undefined;
  const id = wireString(data.id) ? data.id : undefined;
  const name = typeof data.name === "string" && data.name.length <= 256 && !/[\x00-\x1f\x7f]/.test(data.name)
    ? data.name : undefined;
  return id || name ? { ...(id ? { id } : {}), ...(name ? { name } : {}) } : undefined;
}

/**
 * Initialize the consumer account on one explicitly approved origin.
 * The minimal metadata body is a public upstream protocol clue, not a claim of
 * byte-for-byte CLI capture. Only cloudaicompanionProject is recognized; no
 * guessed UUID, onboarding, explicit GCP project_id, or endpoint probing.
 */
export async function initializeAccount(token: string, options: InitializeAccountOptions = {}): Promise<AccountInitialization> {
  options.signal?.throwIfAborted();
  if (!wireString(token)) throw invalidCredentials();
  const baseUrl = assertOfficialBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
  const response = await (options.postJson ?? postJson)(baseUrl, "/v1internal:loadCodeAssist", token,
    { metadata: { ideType: "ANTIGRAVITY" } }, options.signal);
  options.signal?.throwIfAborted();
  const data = record(response);
  const project = data?.cloudaicompanionProject;
  const projectId = typeof project === "string" ? project : record(project)?.id;
  if (!wireString(projectId)) {
    throw new Error("Antigravity loadCodeAssist did not return a Cloud Code Assist project; automatic onboarding is not implemented.");
  }
  return { baseUrl, projectId, ...(tier(data?.currentTier) ? { currentTier: tier(data?.currentTier) } : {}),
    ...(tier(data?.paidTier) ? { paidTier: tier(data?.paidTier) } : {}) };
}

/**
 * Static verification: official CLI 1.5.9 darwin-arm archive, SHA-512 recorded
 * in test/fixtures/agy-cli-1.5.9/manifest.json. CLI backend/auth (not acpauth):
 * getOauthParams consumer branch 0x102b7584c, getScopesByAuthMethod
 * 0x102b759b0, StartInteractive 0x102b74e60, completeOAuth.func1.1
 * 0x102b7a400. Google Endpoint has AuthStyleInParams (1). It calls standard
 * oauth2 Config.Exchange and tokenRefresher.Token. These are public client
 * application parameters, not user credentials. Static verification is not
 * a live /login acceptance test. We require full URLs/state rather than the
 * CLI's more permissive bare-code input; no localhost/ACP flow is implemented.
 */
export const OAUTH_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const OAUTH_CLIENT_SECRET = "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";
export const OAUTH_AUTH_URL = "https://accounts.google.com/o/oauth2/auth";
export const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const OAUTH_REDIRECT_URI = "https://antigravity.google/oauth-callback";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
export const OAUTH_SCOPES = Object.freeze([
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
  "https://www.googleapis.com/auth/aicode",
  "openid",
]);
export interface AuthOptions extends InitializeAccountOptions {
  fetch?: typeof fetch;
  now?: () => number;
  requestTimeoutMs?: number;
  loginTimeoutMs?: number;
}

/** Errors retain only allowlisted OAuth codes, never token response bodies. */
export class AntigravityOAuthError extends Error {
  constructor(readonly status: number, readonly code?: string) {
    super(`Antigravity OAuth request failed (HTTP ${status}${code ? `, ${code}` : ""}).`);
    this.name = "AntigravityOAuthError";
  }
}
const SAFE_OAUTH_CODES = new Set(["invalid_grant", "invalid_client", "invalid_request", "unauthorized_client", "unsupported_grant_type", "access_denied", "temporarily_unavailable", "server_error"]);

/** Strict manual callback parsing. No arbitrary redirect origins or bare codes. */
export function parseOAuthCallback(value: string, expectedState: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error("Paste the complete Antigravity callback URL including code and state."); }
  if (url.origin + url.pathname !== OAUTH_REDIRECT_URI || url.username || url.password || url.hash) {
    throw new Error("Unexpected Antigravity OAuth callback URL.");
  }
  const state = url.searchParams.getAll("state");
  const a = Buffer.from(state[0] ?? "");
  const b = Buffer.from(expectedState);
  if (state.length !== 1 || !b.length || a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error("Antigravity OAuth state mismatch; restart login.");
  }
  if (url.searchParams.has("error")) throw new Error("Antigravity OAuth authorization was denied.");
  const code = url.searchParams.getAll("code");
  if (code.length !== 1 || !wireString(code[0])) throw new Error("Antigravity OAuth callback is missing a valid authorization code.");
  return code[0];
}

async function oauthJson(url: string, init: RequestInit, signal: AbortSignal, options: AuthOptions): Promise<Record<string, unknown>> {
  signal.throwIfAborted();
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(options.requestTimeoutMs ?? 30_000)]);
  let response: Response;
  let text: string;
  try {
    response = await (options.fetch ?? fetch)(url, { ...init, redirect: "error", signal: bounded });
    text = await readBoundedBody(response, 64 * 1024, bounded);
  } catch {
    bounded.throwIfAborted();
    throw new Error("Antigravity OAuth network request failed.");
  }
  bounded.throwIfAborted();
  let data: Record<string, unknown> | undefined;
  try { data = record(JSON.parse(text)); } catch { /* Never retain parser errors containing secrets. */ }
  if (!response.ok) {
    const code = typeof data?.error === "string" && SAFE_OAUTH_CODES.has(data.error) ? data.error : undefined;
    throw new AntigravityOAuthError(response.status, code);
  }
  if (!data) throw new Error("Antigravity OAuth returned an invalid JSON object.");
  return data;
}
async function exchangeToken(params: Record<string, string>, signal: AbortSignal, options: AuthOptions): Promise<Record<string, unknown>> {
  return oauthJson(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": CLIENT_USER_AGENT },
    body: new URLSearchParams({ client_id: OAUTH_CLIENT_ID, client_secret: OAUTH_CLIENT_SECRET, ...params }).toString(),
  }, signal, options);
}
function tokenFields(data: Record<string, unknown>, now: number, previousRefresh?: string): OAuthCredentials {
  const refresh = data.refresh_token === undefined ? previousRefresh : data.refresh_token;
  const seconds = data.expires_in;
  if (!wireString(data.access_token) || !wireString(refresh) || typeof seconds !== "number" ||
    !Number.isFinite(seconds) || seconds <= 0 || !Number.isSafeInteger(now + seconds * 1000) ||
    (data.token_type !== undefined && (typeof data.token_type !== "string" || data.token_type.toLowerCase() !== "bearer"))) {
    throw new Error("Antigravity OAuth returned invalid or incomplete token data.");
  }
  return { access: data.access_token, refresh, expires: now + seconds * 1000 };
}
function waitForPrompt<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Native manual-paste OAuth login; returns credentials for Pi to store. */
export async function loginAntigravity(interaction: ProviderAuthInteraction, options: AuthOptions = {}): Promise<AntigravityOAuthCredential> {
  const signal = AbortSignal.any([interaction.signal, ...(options.signal ? [options.signal] : []), AbortSignal.timeout(options.loginTimeoutMs ?? 5 * 60_000)]);
  signal.throwIfAborted();
  const baseUrl = assertOfficialBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const params = new URLSearchParams({ client_id: OAUTH_CLIENT_ID, redirect_uri: OAUTH_REDIRECT_URI,
    response_type: "code", scope: OAUTH_SCOPES.join(" "), code_challenge: challenge, code_challenge_method: "S256",
    state, access_type: "offline", prompt: "consent" });
  interaction.notify({ type: "auth_url", url: `${OAUTH_AUTH_URL}?${params}`,
    instructions: "Sign in, then paste the complete final Antigravity callback URL (including code and state)." });
  const pasted = await waitForPrompt(interaction.prompt({ type: "manual_code", message: "Paste the complete Antigravity callback URL:", signal }), signal);
  signal.throwIfAborted();
  const code = parseOAuthCallback(pasted, state);
  const now = (options.now ?? Date.now)();
  const data = await exchangeToken({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: OAUTH_REDIRECT_URI }, signal, options);
  const fields = tokenFields(data, now);
  interaction.notify({ type: "progress", message: "Initializing Antigravity account." });
  const user = await oauthJson(USERINFO_URL, { method: "GET", headers: { Authorization: `Bearer ${fields.access}`, "User-Agent": CLIENT_USER_AGENT } }, signal, options);
  const accountEmail = email(user.email);
  if (!accountEmail) throw new Error("Antigravity OAuth user info did not contain a valid account email.");
  const account = await initializeAccount(fields.access, { ...options, baseUrl, signal });
  signal.throwIfAborted();
  return { ...fields, type: "oauth", projectId: account.projectId, email: accountEmail };
}

/** Refresh only the current credential; preserve project/email and token rotation. */
export async function refreshAntigravityToken(credential: OAuthCredential, signal: AbortSignal, options: AuthOptions = {}): Promise<AntigravityOAuthCredential> {
  signal = options.signal ? AbortSignal.any([signal, options.signal]) : signal;
  signal.throwIfAborted();
  assertOfficialBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
  if (!wireString(credential.refresh)) throw invalidCredentials();
  if (credential.email !== undefined && !email(credential.email)) throw invalidCredentials();
  // Require initialized credentials before rotating: no fallible discovery may
  // discard the only valid replacement refresh token after the exchange.
  if (!wireString(credential.projectId)) throw invalidCredentials();
  const ownershipId = email(credential.email) ? undefined : fallbackOwnershipId(credential);
  const now = (options.now ?? Date.now)();
  const fields = tokenFields(await exchangeToken({ grant_type: "refresh_token", refresh_token: credential.refresh }, signal, options), now, credential.refresh);
  // No discovery after token rotation when projectId is already known: avoid
  // losing the rotated credential due to an unrelated initialization failure.
  const projectId = credential.projectId;
  signal.throwIfAborted();
  return { ...credential, ...fields, type: "oauth", projectId,
    ...(ownershipId === undefined ? {} : { antigravityOwnershipId: ownershipId }) };
}

/** Native auth. Pi owns locking, persistence, login/logout and caller cancellation. */
export function createAntigravityAuth(options: AuthOptions = {}): ProviderAuth {
  return { oauth: {
    name: "Antigravity", isSubscription: true, loginLabel: "Sign in with Google (Antigravity subscription)",
    login: interaction => loginAntigravity(interaction, options),
    refresh: (credential, signal) => refreshAntigravityToken(credential, signal, options),
    async toAuth(credential) { return { apiKey: getApiKey(credential) }; },
  } };
}
