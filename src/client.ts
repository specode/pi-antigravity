import { arch, platform } from "node:process";

export const DEFAULT_BASE_URL = "https://daily-cloudcode-pa.googleapis.com";
const OFFICIAL_ORIGINS = new Set([
  DEFAULT_BASE_URL,
  "https://cloudcode-pa.googleapis.com",
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
]);
export const CLIENT_VERSION = "1.5.9";
export const CLIENT_BUILD = "1021519450";
export const CLIENT_USER_AGENT = `antigravity/cli/${CLIENT_VERSION} (aidev_client; os_type=${platform === "win32" ? "windows" : platform}; arch=${arch === "x64" ? "amd64" : arch}; cl=${CLIENT_BUILD}; auth_method=consumer)`;

/** Only official HTTPS origins can receive subscription credentials. No path overrides. */
export function assertOfficialBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || !OFFICIAL_ORIGINS.has(url.origin)) {
    throw new Error("Antigravity requires an approved official HTTPS origin.");
  }
  return url.origin;
}

export class AntigravityHttpError extends Error {
  readonly status: number;
  readonly details: unknown;
  constructor(status: number, details: unknown) {
    super(`Antigravity HTTP ${status}: ${JSON.stringify(details)}`);
    this.name = "AntigravityHttpError";
    this.status = status;
    this.details = details;
  }
}

export interface JsonRequestOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** One bounded request; no endpoint failover, redirects, or internal retries. */
export async function postJson(
  baseUrl: string,
  path: string,
  token: string,
  payload: unknown,
  signal?: AbortSignal,
  options: JsonRequestOptions = {},
): Promise<unknown> {
  const origin = assertOfficialBaseUrl(baseUrl);
  if (!/^\/v1internal:[A-Za-z]+$/.test(path)) throw new Error("Invalid Antigravity operation path.");
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await (options.fetch ?? fetch)(`${origin}${path}`, {
    method: "POST",
    redirect: "error",
    signal: requestSignal,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": CLIENT_USER_AGENT,
    },
    body: JSON.stringify(payload),
  });
  const body = await readBoundedBody(response, 4 * 1024 * 1024, requestSignal);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    if (response.ok) throw new Error("Antigravity returned invalid JSON.");
    parsed = body;
  }
  if (!response.ok) throw new AntigravityHttpError(response.status, parsed);
  requestSignal.throwIfAborted();
  return parsed;
}

export async function readBoundedBody(response: Response, limit: number, signal?: AbortSignal): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const abort = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    while (true) {
      const chunk = await reader.read();
      signal?.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) throw new Error("Antigravity response exceeds the size limit.");
      chunks.push(chunk.value);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } finally {
    signal?.removeEventListener("abort", abort);
    // A broken injected source must not hold cancellation or timeout open.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
