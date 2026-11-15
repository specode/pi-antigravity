import type { Api, Model, Provider, ProviderAuth, StreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAntigravityAuth, parseApiKey } from "./auth.ts";
import { createAntigravityCatalog } from "./catalog.ts";
import { assertOfficialBaseUrl, DEFAULT_BASE_URL, postJson } from "./client.ts";
import { buildRequest, createRequestIdentity, createSessionIdentity } from "./request.ts";
import { streamAntigravity, type AntigravityStreamOptions } from "./stream.ts";

export const PROVIDER_ID = "antigravity";
export const API_ID = "antigravity";

export interface AntigravityProviderOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  /** Injection for isolated integration tests; production uses native OAuth. */
  auth?: ProviderAuth;
  now?: () => number;
  refreshIntervalMs?: number;
}

/** No global registry, CLI storage, startup I/O, tools, polling, or background resources. */
export function antigravityProvider(options: AntigravityProviderOptions = {}): Provider {
  const baseUrl = assertOfficialBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
  const catalog = createAntigravityCatalog({
    api: API_ID,
    baseUrl,
    now: options.now,
    refreshIntervalMs: options.refreshIntervalMs,
    postJson: (origin, path, token, payload, signal) => postJson(origin, path, token, payload, signal, { fetch: options.fetch }),
  });
  const stream = (model: Model<Api>, context: TranscriptContext, requestOptions?: StreamOptions) => streamAntigravity(model, context, requestOptions, {
    fetch: options.fetch,
    resolveCredentials(requestModel, streamOptions) {
      const credential = parseApiKey(streamOptions.apiKey);
      return { token: credential.token, baseUrl: assertOfficialBaseUrl(requestModel.baseUrl || baseUrl) };
    },
    buildPayload(requestModel, transcript, streamOptions: AntigravityStreamOptions) {
      const credential = parseApiKey(streamOptions.apiKey);
      const route = catalog.resolveRoute(requestModel.id, streamOptions.reasoning, { ...credential, baseUrl: requestModel.baseUrl || baseUrl });
      // Pi supplies a different session ID for forks. A missing ID means an
      // ephemeral direct call; never infer shared session identity from prompt text.
      const sessionKey = streamOptions.sessionId === undefined ? undefined
        : JSON.stringify([credential.email?.toLowerCase() ?? credential.ownershipId ?? credential.token, credential.projectId, streamOptions.sessionId]);
      const session = createSessionIdentity(sessionKey);
      // Local transcript bookkeeping, not a reconstruction of unobserved CLI
      // retry counters. Per-attempt UUIDs keep concurrent requests distinct.
      const requestIndex = transcript.messages.filter(message => message.role === "assistant").length;
      const identity = createRequestIdentity(session, credential.projectId, { requestIndex, timestamp: options.now?.() });
      return buildRequest(requestModel, transcript, streamOptions, route, identity);
    },
  });
  return {
    id: PROVIDER_ID,
    name: "Antigravity",
    baseUrl,
    auth: options.auth ?? createAntigravityAuth({
      baseUrl,
      fetch: options.fetch,
      now: options.now,
      postJson: (origin, path, token, payload, signal) => postJson(origin, path, token, payload, signal, { fetch: options.fetch }),
    }),
    getModels: catalog.getModels,
    filterModels: catalog.filterModels,
    refreshModels: catalog.refreshModels,
    stream,
    streamSimple: stream,
  };
}

export default function antigravity(pi: ExtensionAPI): void {
  pi.registerProvider(antigravityProvider());
}
