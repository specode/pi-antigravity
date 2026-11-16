import { createHash } from "node:crypto";
import type { Api, Credential, Model, ModelThinkingLevel, ModelsStoreEntry, RefreshModelsContext } from "@earendil-works/pi-ai";
import { getApiKey, initializeAccount, parseApiKey, type AntigravityApiKey } from "./auth.ts";
import { assertOfficialBaseUrl, DEFAULT_BASE_URL, postJson } from "./client.ts";

/** A selected runtime, not an assertion about response.modelVersion. */
export interface CatalogRoute {
  runtimeId: string;
  modelEnum: string;
  thinkingLevel?: "LOW" | "MEDIUM" | "HIGH" | "XHIGH";
}
export interface CatalogModelRoutes {
  default: CatalogRoute;
  levels: Partial<Record<ModelThinkingLevel, CatalogRoute>>;
}
export interface AntigravityCatalog {
  models: Model<Api>[];
  routes: Record<string, CatalogModelRoutes>;
  /** Sanitized discovery data sufficient to rebuild the cache, without quota/account data. */
  source: CatalogSource;
}
interface CatalogSource {
  models: Record<string, {
    displayName: string;
    model: string;
    maxTokens: number;
    maxOutputTokens: number;
    supportsThinking: boolean;
    /** Raw directory int32, not the generationConfig string enum. */
    thinkingLevel?: number;
    supportsImages: boolean;
    recommended: true;
  }>;
}
/** Extension metadata travels through Pi's public ModelsStore; no separate files. */
export interface AntigravityStoredCatalog extends ModelsStoreEntry {
  antigravity: { schemaVersion: 1; accountKey: string; baseUrl: string; source: CatalogSource };
}
export interface CatalogOptions {
  /** Must match the custom streaming API ID used by the parent Provider. */
  api?: Api;
  baseUrl?: string;
  postJson?: typeof postJson;
  now?: () => number;
  refreshIntervalMs?: number;
}
/** Pass the parsed JSON bridge; token is only needed to guard accounts without email. */
export type CatalogOwnership = Pick<AntigravityApiKey, "projectId" | "email" | "ownershipId"> & { token?: string; baseUrl?: string };
export interface AntigravityCatalogController {
  getModels(): readonly Model<Api>[];
  filterModels(models: readonly Model<Api>[], credential: Credential | undefined): readonly Model<Api>[];
  refreshModels(context: RefreshModelsContext): Promise<void>;
  /** Unsupported explicit effort fails; no generation/effort fallback. */
  resolveRoute(publicId: string, thinkingLevel?: ModelThinkingLevel, ownership?: CatalogOwnership): CatalogRoute;
  /** Guard direct stream calls, which bypass model-picker filtering. */
  assertOwnership(ownership: CatalogOwnership): void;
}
const LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const EFFORTS = { low: "LOW", medium: "MEDIUM", high: "HIGH", xhigh: "XHIGH" } as const;
const REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function runtimeId(id: string): boolean {
  return /^[a-z0-9][a-z0-9_.-]{0,199}$/.test(id) && !/^(?:model_|chat_|tab_)/i.test(id);
}
function cleanName(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value)
    ? value : fallback;
}
function invalidCatalog(): Error { return new Error("Antigravity returned an empty, unsupported, or malformed chat catalog."); }

/**
 * Parse the models dictionary and curated agentModelSorts.groups[].modelIds.
 * Field names were checked against official CLI 1.5.9 ModelDetails protobuf
 * getters (0x1009419c0 onward), corroborating public upstream discovery code.
 * Proto3 false booleans can be omitted. The handoff captures contain no raw
 * directory replies; static declarations do not prove every account's payload.
 * No fuzzy family merges,
 * placeholder IDs, guessed limits/prices, or synthetic thinking-budget levels.
 * Only explicit low/medium/high/xhigh suffixes are grouped; unknown efforts are not advertised.
 */
export function buildAntigravityCatalog(payload: unknown, baseUrl = DEFAULT_BASE_URL, api: Api = "antigravity"): AntigravityCatalog {
  baseUrl = assertOfficialBaseUrl(baseUrl);
  const root = record(payload);
  const raw = record(root?.models);
  if (!raw || Object.keys(raw).length === 0 || Object.keys(raw).length > 4096) throw invalidCatalog();
  const curated = new Set<string>();
  if (root?.agentModelSorts !== undefined) {
    if (!Array.isArray(root.agentModelSorts)) throw invalidCatalog();
    for (const sort of root.agentModelSorts) {
      const groups = record(sort)?.groups;
      if (!Array.isArray(groups)) continue;
      for (const group of groups) {
        const ids = record(group)?.modelIds;
        if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string") curated.add(id);
      }
    }
  } else {
    // Without a curated list, require an explicit recommendation. Do not expose
    // every internal entry merely because its name looks like a chat model.
    for (const [id, value] of Object.entries(raw)) if (record(value)?.recommended === true) curated.add(id);
  }
  const imageIds = new Set(Array.isArray(root?.imageGenerationModelIds) ? root.imageGenerationModelIds : []);
  const source: CatalogSource = { models: Object.create(null) };
  const groups = new Map<string, { name: string; entries: { id: string; info: CatalogSource["models"][string]; route: CatalogRoute; level: ModelThinkingLevel }[] }>();
  for (const id of curated) {
    const info = record(raw[id]);
    if (!runtimeId(id) || !info || imageIds.has(id) || /(?:^|[-_])image(?:[-_]|$)/i.test(id) ||
      info.isInternal === true || info.disabled === true || info.apiProvider === "API_PROVIDER_INTERNAL") continue;
    if (!positive(info.maxTokens) || !positive(info.maxOutputTokens) ||
      (info.supportsThinking !== undefined && typeof info.supportsThinking !== "boolean") ||
      (info.supportsImages !== undefined && typeof info.supportsImages !== "boolean") ||
      typeof info.model !== "string" || !/^MODEL_[A-Z0-9_]+$/.test(info.model)) throw invalidCatalog();
    const suffix = /^(.*)-(low|medium|high|xhigh)$/.exec(id);
    // The CLI protobuf declares thinking_level as int32, not an enum. Its
    // numeric semantics are not established by these captures. Preserve it,
    // but do not reinterpret it as generationConfig.thinkingLevel.
    if (info.thinkingLevel !== undefined && (typeof info.thinkingLevel !== "number" ||
      !Number.isInteger(info.thinkingLevel) || info.thinkingLevel < -2147483648 || info.thinkingLevel > 2147483647)) throw invalidCatalog();
    const supportsThinking = info.supportsThinking === true;
    if (supportsThinking && !suffix) continue;
    if (!supportsThinking && suffix) throw invalidCatalog();
    const level: ModelThinkingLevel = suffix ? suffix[2] as keyof typeof EFFORTS : "off";
    const publicId = suffix ? suffix[1] : id;
    const name = cleanName(info.displayName ?? info.label ?? info.modelName, publicId).replace(/\s*\((?:low|medium|high|xhigh)\)\s*$/i, "");
    const normalized: CatalogSource["models"][string] = {
      displayName: name, model: info.model, maxTokens: info.maxTokens, maxOutputTokens: info.maxOutputTokens,
      supportsThinking, ...(typeof info.thinkingLevel === "number" ? { thinkingLevel: info.thinkingLevel } : {}),
      supportsImages: info.supportsImages === true, recommended: true,
    };
    source.models[id] = normalized;
    const route: CatalogRoute = { runtimeId: id, modelEnum: info.model,
      ...(level !== "off" ? { thinkingLevel: EFFORTS[level as keyof typeof EFFORTS] } : {}) };
    let group = groups.get(publicId);
    if (!group) { group = { name, entries: [] }; groups.set(publicId, group); }
    group.entries.push({ id, info: normalized, route, level });
  }
  if (!groups.size) throw invalidCatalog();
  const models: Model<Api>[] = [];
  const routes: Record<string, CatalogModelRoutes> = Object.create(null);
  for (const [id, group] of groups) {
    const levels: CatalogModelRoutes["levels"] = {};
    const reasoning = group.entries.every(entry => entry.info.supportsThinking);
    if (!reasoning && group.entries.some(entry => entry.info.supportsThinking)) throw invalidCatalog();
    for (const entry of group.entries) {
      if (levels[entry.level]) throw invalidCatalog();
      levels[entry.level] = entry.route;
    }
    const defaultRoute = levels.off ?? levels.low ?? levels.medium ?? levels.high ?? levels.xhigh;
    if (!defaultRoute) throw invalidCatalog();
    routes[id] = { default: defaultRoute, levels };
    models.push({ type: "chat", id, name: group.name, provider: "antigravity", api, baseUrl, reasoning,
      ...(reasoning ? { thinkingLevelMap: Object.fromEntries(LEVELS.map(level => [level, levels[level] ? level : null])) } : {}),
      input: group.entries.every(entry => entry.info.supportsImages) ? ["text", "image"] : ["text"],
      // Subscription access has no verified per-token billing rate. Zero means
      // unpriced in Pi, not a claim of free API usage or a subscription invoice.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: Math.min(...group.entries.map(entry => entry.info.maxTokens)),
      maxTokens: Math.min(...group.entries.map(entry => entry.info.maxOutputTokens)),
    });
  }
  return { models, routes, source };
}

/** Stable across access-token refreshes, isolated by account/project and official origin. */
export function accountCatalogKey(credential: Credential | undefined, baseUrl = DEFAULT_BASE_URL): string | undefined {
  if (credential?.type !== "oauth") return undefined;
  const material = parseApiKey(getApiKey(credential));
  const identity = material.email ? ["email", material.email.toLowerCase()] : ["ownership", material.ownershipId];
  return createHash("sha256").update(JSON.stringify(["antigravity-catalog-v1", assertOfficialBaseUrl(baseUrl), identity, material.projectId])).digest("hex");
}

/**
 * Spread these three Provider methods onto the parent native Provider (do not
 * pass as legacy refreshModels/fetchModels). Pi owns credential refresh and the
 * generation-checked persistence transaction. resolveRoute is used by chat.
 * Offline cache restoration needs the effective stored OAuth credential; without
 * it no account-owned models are hydrated. Errors propagate while the same
 * account's last good catalog survives. Account changes hide the old catalog.
 */
export function createAntigravityCatalog(options: CatalogOptions = {}): AntigravityCatalogController {
  const baseUrl = assertOfficialBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
  const api = options.api ?? "antigravity";
  const now = options.now ?? Date.now;
  const interval = options.refreshIntervalMs ?? REFRESH_INTERVAL_MS;
  if (!Number.isFinite(interval) || interval < 0) throw new Error("Invalid catalog refresh interval.");
  const transport = options.postJson ?? postJson;
  type State = { accountKey: string; baseUrl: string; checkedAt: number; catalog: AntigravityCatalog; owner: { projectId: string; email?: string; ownershipId?: string; tokenDigest: string } };
  let state: State | undefined;
  let generation = 0;
  const digest = (token: string) => createHash("sha256").update(token).digest("hex");
  const assertOwnership = (material: CatalogOwnership) => {
    const owner = state?.owner;
    const sameAccount = owner?.email ? owner.email.toLowerCase() === material.email?.toLowerCase()
      : !material.email && (material.ownershipId !== undefined
        ? owner?.ownershipId === material.ownershipId
        : typeof material.token === "string" && owner?.tokenDigest === digest(material.token));
    if (!owner || owner.projectId !== material.projectId || !sameAccount ||
      (material.baseUrl !== undefined && assertOfficialBaseUrl(material.baseUrl) !== state?.baseUrl)) {
      throw new Error("Antigravity catalog belongs to a different account or endpoint; refresh models before streaming.");
    }
  };
  return {
    getModels: () => structuredClone(state?.catalog.models ?? []),
    filterModels(models, credential) {
      try { return state && accountCatalogKey(credential, state.baseUrl) === state.accountKey ? models : []; }
      catch { return []; }
    },
    assertOwnership,
    resolveRoute(publicId, level, ownership) {
      if (ownership) assertOwnership(ownership);
      const entry = state?.catalog.routes[publicId];
      const route = level === undefined ? entry?.default : entry?.levels[level];
      if (!route) throw new Error("Antigravity model or requested thinking level is not in the current catalog.");
      return { ...route };
    },
    async refreshModels(context) {
      const currentGeneration = ++generation;
      const signal = context.signal;
      signal.throwIfAborted();
      const origin = assertOfficialBaseUrl(context.baseUrl ?? baseUrl);
      const key = accountCatalogKey(context.credential, origin);
      const publish = async (publication: Parameters<RefreshModelsContext["publish"]>[0]): Promise<boolean> => {
        signal.throwIfAborted();
        if (generation !== currentGeneration) return false;
        const update = publication.update;
        return context.publish({ ...publication, update: () => {
          if (generation === currentGeneration && !signal.aborted) update?.();
        } });
      };
      if (state && (state.accountKey !== key || state.baseUrl !== origin)) {
        if (!await publish({ update: () => { state = undefined; } })) return;
      }
      if (!key || context.credential?.type !== "oauth") return;
      const material = parseApiKey(getApiKey(context.credential));
      const owner = { projectId: material.projectId, email: material.email, ownershipId: material.ownershipId, tokenDigest: digest(material.token) };
      // Update ephemeral token binding after native OAuth refresh, including a TTL hit.
      if (state && state.owner.tokenDigest !== owner.tokenDigest) {
        if (!await publish({ update: () => { if (state) state = { ...state, owner }; } })) return;
      }
      // Validate cached source rather than trusting deserialized model objects,
      // request URLs, or routing enums. Ignore pre-upgrade/unowned snapshots.
      const stored = record(context.stored);
      const cache = record(stored?.antigravity);
      if (!state && cache?.schemaVersion === 1 && cache.accountKey === key && cache.baseUrl === origin &&
        typeof stored?.checkedAt === "number" && Number.isFinite(stored.checkedAt) && stored.checkedAt >= 0) {
        let catalog: AntigravityCatalog | undefined;
        try { catalog = buildAntigravityCatalog(cache.source, origin, api); }
        catch { /* Malformed caches are ignored; network discovery can repair them. */ }
        if (catalog) {
          const restored = catalog;
          const checkedAt = stored.checkedAt as number;
          if (!await publish({ update: () => { state = { accountKey: key, baseUrl: origin, checkedAt, catalog: restored, owner }; } })) return;
        }
      }
      if (!context.allowNetwork) return;
      const timestamp = now();
      if (!context.force && state && timestamp >= state.checkedAt && timestamp - state.checkedAt < interval) return;
      const account = await initializeAccount(material.token, { baseUrl: origin, signal, postJson: transport });
      if (account.projectId !== material.projectId) {
        throw new Error("Antigravity initialized a different Cloud Code Assist project; credential re-initialization is required.");
      }
      const payload = await transport(account.baseUrl, "/v1internal:fetchAvailableModels", material.token, { project: account.projectId }, signal);
      signal.throwIfAborted();
      const catalog = buildAntigravityCatalog(payload, account.baseUrl, api);
      const checkedAt = now();
      const persist: AntigravityStoredCatalog = { models: catalog.models, checkedAt,
        antigravity: { schemaVersion: 1, accountKey: key, baseUrl: origin, source: catalog.source } };
      await publish({ persist, update: () => { state = { accountKey: key, baseUrl: origin, checkedAt, catalog, owner }; } });
    },
  };
}
