import { createHash, randomUUID } from "node:crypto";
import type { Api, Model, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { convertMessages, convertTools, mapToolChoice } from "./google-shared.ts";

const PI_OPENING = "You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.";
const CLI_OPENING = "You are a coding agent helping the user with their project.";
const THINKING_LEVELS = new Set(["MINIMAL", "LOW", "MEDIUM", "HIGH"]);

/** Accept explicit off at this boundary; Pi's simple options normally represent it as undefined. */
export type RequestOptions = Omit<SimpleStreamOptions, "reasoning"> & {
	reasoning?: SimpleStreamOptions["reasoning"] | "off";
};

/** Catalog-selected route, already resolved for the requested thinking level. */
export interface RequestRoute {
	runtimeId: string;
	modelEnum: string;
	thinkingLevel?: "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";
}

export interface SessionIdentity {
	readonly cascadeId: string;
	readonly rootCascadeId: string;
	readonly trajectoryId: string;
}

export interface RequestIdentity extends SessionIdentity {
	readonly projectId: string;
	readonly requestUuid: string;
	readonly timestamp: number;
	readonly requestIndex: number;
	/** Override after compaction/resume if the caller has a persisted logical step. */
	readonly step?: number;
}

export interface RequestIdentityOptions {
	requestIndex?: number;
	step?: number;
	timestamp?: number;
}

export interface CliRequest {
	project: string;
	model: string;
	requestId: string;
	requestType: "agent";
	userAgent: "antigravity";
	request: {
		contents: ReturnType<typeof convertMessages>;
		systemInstruction: { role: "user"; parts: { text: string }[] };
		tools: NonNullable<ReturnType<typeof convertTools>>;
		labels: {
			cascade_id: string;
			root_cascade_id: string;
			trajectory_id: string;
			request_id: string;
			last_step_index: string;
			model_enum: string;
			used_claude: string;
			used_claude_conservative: string;
			used_non_gemini_model: string;
		};
		generationConfig: {
			maxOutputTokens: number;
			temperature?: number;
			thinkingConfig?: { includeThoughts: true; thinkingLevel: NonNullable<RequestRoute["thinkingLevel"]> };
		};
		sessionId: string;
		toolConfig?: { functionCallingConfig: { mode: ReturnType<typeof mapToolChoice> } };
	};
}

/** Rewrite only the exact known leading sentences, never text elsewhere in the prompt. */
export function rewriteDefaultPrompt(prompt: string): string {
	if (!prompt.startsWith(PI_OPENING)) return prompt;
	const suffix = prompt.slice(PI_OPENING.length);
	if (suffix !== "" && !/^\s/.test(suffix)) return prompt;
	return CLI_OPENING + suffix;
}

/** Official hashToSessionID: UTF-8 bytes, unsigned FNV-1a arithmetic, signed decimal output. */
export function fnvSessionId(seed: string | Uint8Array = ""): string {
	let hash = 0xcbf29ce484222325n;
	const bytes = typeof seed === "string" ? new TextEncoder().encode(seed) : seed;
	for (const byte of bytes) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
	return BigInt.asIntN(64, hash).toString();
}

function sessionUuid(scope: string, key: string): string {
	const bytes = createHash("sha256").update("pi-antigravity/identity/v1\0").update(scope).update("\0").update(key).digest();
	// RFC 9562 UUIDv8: provider-local deterministic identity, not an inferred CLI algorithm.
	bytes[6] = (bytes[6]! & 0x0f) | 0x80;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	const hex = bytes.subarray(0, 16).toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * No process-global state. Pass a stable, account/session/branch-scoped key to resume;
 * use a different key for a fork. Omit it for an ephemeral conversation.
 * These UUIDs are independent of the CLI's FNV sessionId (whose observed seed is empty).
 */
export function createSessionIdentity(sessionKey?: string): SessionIdentity {
	if (sessionKey !== undefined && sessionKey.length === 0) throw new Error("Session key must not be empty");
	const cascadeId = sessionKey === undefined ? randomUUID() : sessionUuid("cascade", sessionKey);
	const trajectoryId = sessionKey === undefined ? randomUUID() : sessionUuid("trajectory", sessionKey);
	return Object.freeze({ cascadeId, rootCascadeId: cascadeId, trajectoryId });
}

/**
 * Create once per logical HTTP attempt; reuse the returned value for exact payload replay.
 * Fresh UUIDs make parallel attempts unique even with identical timestamp/index/step.
 * requestIndex is caller-owned bookkeeping, not a claimed reconstruction of CLI counters.
 */
export function createRequestIdentity(
	session: SessionIdentity,
	projectId: string,
	options: RequestIdentityOptions = {},
): RequestIdentity {
	const identity: RequestIdentity = {
		...session,
		projectId,
		requestUuid: randomUUID(),
		timestamp: options.timestamp ?? Date.now(),
		requestIndex: options.requestIndex ?? 0,
		...(options.step === undefined ? {} : { step: options.step }),
	};
	validateIdentity(identity);
	return Object.freeze(identity);
}

function nonnegativeInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a nonnegative safe integer`);
}

function validateIdentity(identity: RequestIdentity): void {
	const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
	for (const key of ["cascadeId", "rootCascadeId", "trajectoryId", "requestUuid"] as const) {
		if (!uuid.test(identity[key])) throw new Error(`${key} must be a UUID`);
	}
	if (!identity.projectId.trim()) throw new Error("Project ID is required");
	nonnegativeInteger(identity.timestamp, "timestamp");
	nonnegativeInteger(identity.requestIndex, "requestIndex");
	if (identity.step !== undefined) nonnegativeInteger(identity.step, "step");
}

const SCHEMA_MAPS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas", "dependencies"]);
const SUBSCHEMAS = new Set([
	"additionalProperties", "unevaluatedProperties", "propertyNames", "items", "prefixItems",
	"additionalItems", "unevaluatedItems", "contains", "allOf", "anyOf", "oneOf", "not",
	"if", "then", "else", "contentSchema",
]);
const SCHEMA_TYPES = new Set(["string", "number", "integer", "boolean", "array", "object", "null"]);
const SCHEMA_META = new Set(["$schema", "$id", "$anchor", "$dynamicAnchor", "$vocabulary", "$comment", "$defs", "definitions"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Visit schema positions, not arbitrary JSON data. Names (including "type" and
 * "__proto__"), enum/const/default/examples, descriptions and extensions stay intact.
 * No dereferencing or union flattening: unsupported server schemas must fail visibly.
 */
export function uppercaseSchemaTypes(schema: unknown): unknown {
	return transformSchema(schema, false);
}

function transformSchema(schema: unknown, legacyParameters: boolean): unknown {
	if (Array.isArray(schema)) return schema.map((child) => transformSchema(child, legacyParameters));
	if (!isRecord(schema)) return schema;
	if (legacyParameters && (Object.hasOwn(schema, "$ref") || Object.hasOwn(schema, "$dynamicRef"))) {
		throw new Error("CLI parameters do not support schema references; tool declarations must provide an inline schema");
	}
	return Object.fromEntries(Object.entries(schema).filter(([key]) => !legacyParameters || !SCHEMA_META.has(key)).map(([key, value]) => {
		if (key === "type") {
			const upper = (type: unknown) => typeof type === "string" && SCHEMA_TYPES.has(type) ? type.toUpperCase() : type;
			return [key, Array.isArray(value) ? value.map(upper) : upper(value)];
		}
		if (SCHEMA_MAPS.has(key) && isRecord(value)) {
			return [key, Object.fromEntries(Object.entries(value).map(([name, child]) => [name, transformSchema(child, legacyParameters)]))];
		}
		return [key, SUBSCHEMAS.has(key) ? transformSchema(value, legacyParameters) : structuredClone(value)];
	}));
}

function validateThinking(model: Model<Api>, options: RequestOptions | undefined, route: RequestRoute): void {
	if (!route.runtimeId.trim() || !route.modelEnum.trim()) throw new Error("A catalog runtime ID and model enum are required");
	if (options?.thinkingBudgets && Object.values(options.thinkingBudgets).some((value) => value !== undefined)) {
		throw new Error("CLI routes use thinking tiers, not token budgets");
	}
	if (!model.reasoning) {
		if (route.thinkingLevel !== undefined) throw new Error("Nonthinking models must not supply a thinking tier");
		if (options?.reasoning !== undefined && options.reasoning !== "off") throw new Error("Nonthinking models only accept reasoning off");
		return;
	}
	if (route.thinkingLevel === undefined || !THINKING_LEVELS.has(route.thinkingLevel)) throw new Error("Unsupported or missing CLI thinking tier");
	if (options?.reasoning === "off") throw new Error("Requested thinking level off does not match a thinking route");
	if (options?.reasoning !== undefined) {
		const mapped = model.thinkingLevelMap?.[options.reasoning];
		const requested = mapped === undefined ? options.reasoning : mapped;
		if (typeof requested !== "string" || (requested !== route.runtimeId && requested.toUpperCase() !== route.thinkingLevel)) {
			throw new Error(`Requested thinking level ${options.reasoning} does not match catalog route ${route.runtimeId}/${route.thinkingLevel}`);
		}
	}
}

/**
 * Pure serialization. Transport owns onPayload (including replacement), response/stream
 * hooks, authentication headers, endpoint validation, cancellation and HTTP execution.
 * No fallback model, thinking clamp, endpoint retry, or hidden execution ID is created.
 */
export function buildRequest(
	model: Model<Api>,
	context: TranscriptContext,
	options: RequestOptions | undefined,
	route: RequestRoute,
	identity: RequestIdentity,
): CliRequest {
	validateIdentity(identity);
	validateThinking(model, options, route);
	const maxOutputTokens = options?.maxTokens ?? model.maxTokens;
	if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0 || maxOutputTokens > model.maxTokens) {
		throw new Error("maxTokens must be a positive integer within the model output limit");
	}
	if (options?.temperature !== undefined && (!Number.isFinite(options.temperature) || options.temperature < 0)) {
		throw new Error("temperature must be a finite nonnegative number");
	}

	// The public converter's generic accepts Google API names, but its implementation
	// supports this wire format with custom providers. This is a type-only narrowing:
	// changing model.id or model.api here would invalidate same-model thought signatures.
	const contents = structuredClone(convertMessages(model as Model<"google-generative-ai">, context));
	// Only this exact runtime route has a verified function-response role difference.
	if (route.runtimeId === "gemini-3.8-flash-low") {
		for (const content of contents) {
			if (content.parts?.length && content.parts.every((part) => part.functionResponse !== undefined)) content.role = "model";
		}
	}

	const currentTools = getCurrentTools(context.messages);
	const convertedTools = convertTools(currentTools, true, false) ?? [];
	const declarations = convertedTools.flatMap((tool) => tool.functionDeclarations);
	const tools = declarations.map((declaration, index) => ({
		functionDeclarations: [{
			...declaration,
			// Pi 1.5.2's legacy OpenAPI sanitizer walks user name maps as keywords
			// (and skips arrays). Restore the original schema with a position-aware
			// traversal so named properties and literal values are not silently lost.
			// Strip the same meta declarations, but reject references before dropping
			// their definitions rather than sending a silently broken schema.
			parameters: transformSchema(currentTools[index]!.parameters, true),
		}],
	}));
	const step = identity.step ?? Math.max(0, contents.length - 1);
	const usedClaude = route.runtimeId.startsWith("claude-");
	const payload: CliRequest = {
		project: identity.projectId,
		model: route.runtimeId,
		requestId: `agent/${identity.cascadeId}/${identity.timestamp}/${identity.requestUuid}/${step}`,
		requestType: "agent",
		userAgent: "antigravity",
		request: {
			contents,
			systemInstruction: { role: "user", parts: [{ text: rewriteDefaultPrompt(getCurrentSystemPrompt(context.messages)) }] },
			tools,
			labels: {
				cascade_id: identity.cascadeId,
				root_cascade_id: identity.rootCascadeId,
				trajectory_id: identity.trajectoryId,
				request_id: `${identity.requestUuid}-${identity.requestIndex}`,
				last_step_index: String(step),
				model_enum: route.modelEnum,
				used_claude: String(usedClaude),
				used_claude_conservative: String(usedClaude),
				used_non_gemini_model: String(!route.runtimeId.startsWith("gemini-")),
			},
			generationConfig: {
				maxOutputTokens,
				...(options?.temperature === undefined ? {} : { temperature: options.temperature }),
				...(route.thinkingLevel === undefined ? {} : { thinkingConfig: { includeThoughts: true as const, thinkingLevel: route.thinkingLevel } }),
			},
			// The normal CLI path uses an empty seed; Pi's session key is NOT this seed.
			sessionId: fnvSessionId(),
			...(options?.toolChoice === undefined ? {} : {
				toolConfig: { functionCallingConfig: { mode: mapToolChoice(options.toolChoice) } },
			}),
		},
	};
	return payload;
}
