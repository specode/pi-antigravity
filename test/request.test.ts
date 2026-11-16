import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Api, AssistantMessage, Message, Model, SimpleStreamOptions, Tool, TranscriptContext } from "@earendil-works/pi-ai";
import { convertMessages } from "@earendil-works/pi-ai/api/google-shared";
import { getCurrentSystemPrompt, normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import {
	buildRequest,
	createRequestIdentity,
	createSessionIdentity,
	fnvSessionId,
	uppercaseSchemaTypes,
	type RequestRoute,
} from "../src/request.ts";
import { adaptSystemPrompt, rewriteDefaultPrompt } from "../src/prompt.ts";

const OPENING = "You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.";
const REPLACEMENT = "You are a coding agent helping the user with their project.";
const model: Model<Api> = {
	id: "gemini-3.8-flash",
	name: "Synthetic Flash",
	api: "antigravity-chat",
	provider: "antigravity",
	baseUrl: "https://daily-cloudcode-pa.googleapis.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 65536,
};
const route: RequestRoute = {
	runtimeId: "gemini-3.8-flash-low",
	modelEnum: "MODEL_SYNTHETIC_FLASH",
	thinkingLevel: "LOW",
};
const tool: Tool = {
	name: "read",
	description: "Read a synthetic file; keep pi and string unchanged.",
	parameters: { type: "object", properties: { path: { type: "string", description: "A string path" } }, required: ["path"] },
};
const usage: AssistantMessage["usage"] = {
	input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const session = createSessionIdentity("synthetic-account/session/branch");
const identity = createRequestIdentity(session, "synthetic-project", { timestamp: 1800000000000 });
const user = (content = "Read sample.txt"): Message => ({ role: "user", content, timestamp: 1 });

function assistant(content: AssistantMessage["content"], selected = model): AssistantMessage {
	return { role: "assistant", content, api: selected.api, provider: selected.provider, model: selected.id, usage, stopReason: "toolUse", timestamp: 2 };
}

function roundTrip(selected = model): TranscriptContext {
	return normalizeContext({
		systemPrompt: OPENING + "\n\nKeep project rules mentioning pi unchanged.", tools: [tool],
		messages: [
			user(),
			assistant([
				{ type: "thinking", thinking: "", thinkingSignature: "dGhpbmtpbmc=" },
				{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "sample.txt" }, thoughtSignature: "Y2FsbA==" },
				{ type: "text", text: "", textSignature: "ZmluYWw=" },
			], selected),
			{ role: "toolResult", toolCallId: "call_1", toolName: "read", content: [{ type: "text", text: "SYNTHETIC_OK pi" }], isError: false, timestamp: 3 },
		],
	});
}

function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) deepFreeze(child);
		Object.freeze(value);
	}
	return value;
}

test("rewrites only the exact default opening and preserves the complete suffix", () => {
	for (const suffix of ["", "\n\nRules: pi", "\r\n<skills>pi</skills>", " More custom text."]) {
		assert.equal(rewriteDefaultPrompt(OPENING + suffix), REPLACEMENT + suffix);
	}
	for (const prompt of ["", " " + OPENING, "Custom prefix\n" + OPENING, OPENING.replace("pi,", "Pi,"), OPENING.slice(0, -1), OPENING + "custom", "Use pi; inspect pi.txt."]) {
		assert.equal(rewriteDefaultPrompt(prompt), prompt);
	}
	assert.equal(rewriteDefaultPrompt(OPENING + "\n" + OPENING), REPLACEMENT + "\n" + OPENING);
});

test("project instructions reference the known opener without reinjecting its literal text", () => {
	const instructions = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
	assert.equal(instructions.includes(OPENING), false, "The exact opener must stay in source, not in injected project documentation");
	assert.ok(instructions.includes("`src/prompt.ts`"));
	assert.ok(instructions.includes("`PI_OPENING`"));
});

test("builds the CLI outer envelope with catalog routing, labels and empty-seed sessionId", () => {
	const result = buildRequest(model, normalizeContext({ messages: [user()] }), undefined, route, identity);
	assert.deepEqual(Object.keys(result).sort(), ["model", "project", "request", "requestId", "requestType", "userAgent"]);
	assert.equal(result.model, route.runtimeId);
	assert.equal(result.project, "synthetic-project");
	assert.equal(result.requestType, "agent");
	assert.equal(result.userAgent, "antigravity");
	assert.equal(result.requestId, `agent/${session.cascadeId}/1800000000000/${identity.requestUuid}/0`);
	assert.deepEqual(result.request.labels, {
		cascade_id: session.cascadeId, root_cascade_id: session.rootCascadeId, trajectory_id: session.trajectoryId,
		request_id: `${identity.requestUuid}-0`, last_step_index: "0", model_enum: "MODEL_SYNTHETIC_FLASH",
		used_claude: "false", used_claude_conservative: "false", used_non_gemini_model: "false",
	});
	assert.deepEqual(result.request.generationConfig, { maxOutputTokens: 65536, thinkingConfig: { includeThoughts: true, thinkingLevel: "LOW" } });
	assert.equal(result.request.sessionId, "-3750763034362895579");
	assert.deepEqual(result.request.systemInstruction, { role: "user", parts: [{ text: "" }] });
	assert.deepEqual(result.request.tools, []);
	assert.equal(JSON.stringify(result).includes("last_execution_id"), false);
});

test("reads prompt sections and current tools from transcript deltas, ignoring legacy fields", () => {
	const messages: Message[] = [
		{ role: "system", content: OPENING, sections: { rules: "Old rules", removed: "Remove me" }, toolsAdded: [tool], timestamp: 0 },
		user(OPENING),
		{ role: "system", content: "Additional pi instructions", sections: { rules: "New pi rules", removed: null, skills: "<skills>pi</skills>" }, toolsRemoved: [{ name: "read" }], toolsAdded: [{ ...tool, name: "inspect" }], timestamp: 4 },
	];
	const context = Object.assign(normalizeContext({ messages }), { systemPrompt: "Wrong legacy prompt", tools: [tool] });
	const before = structuredClone(context);
	const result = buildRequest(model, context, undefined, route, identity);
	assert.equal(result.request.systemInstruction.parts[0]!.text, adaptSystemPrompt(messages));
	assert.equal(result.request.systemInstruction.parts[0]!.text, rewriteDefaultPrompt(getCurrentSystemPrompt(messages)));
	assert.ok(result.request.systemInstruction.parts[0]!.text.includes("New pi rules"));
	assert.ok(!result.request.systemInstruction.parts[0]!.text.includes("Old rules"));
	assert.deepEqual(result.request.contents, [{ role: "user", parts: [{ text: OPENING }] }]);
	assert.deepEqual(result.request.tools.map((entry) => entry.functionDeclarations[0]!.name), ["inspect"]);
	assert.deepEqual(context, before);
});

test("schema traversal uppercases keyword types without rewriting name maps or literal data", () => {
	const schema = JSON.parse(`{
		"type":"object", "description":"string object pi", "required":["type","properties"],
		"properties": {
			"type":{"type":"string","enum":["string","object"]},
			"properties":{"type":"object","properties":{"type":{"type":"integer"}}},
			"items":{"type":"array","items":{"type":["string","null"]}},
			"__proto__":{"type":"boolean"}, "$id":{"type":"number"}, "$defs":{"type":"string"}
		},
		"default":{"type":"string","properties":{"type":"object"}},
		"enum":[{"type":"string"}], "const":{"type":"integer"}, "examples":[{"type":"object"}],
		"x-custom":{"type":"string"}, "$ref":"#/$defs/node",
		"$defs":{"type":{"type":"string"},"node":{"type":"object"}}
	}`);
	const original = structuredClone(schema);
	const result = uppercaseSchemaTypes(deepFreeze(schema)) as typeof schema;
	assert.equal(result.type, "OBJECT");
	assert.equal(result.properties.type.type, "STRING");
	assert.equal(result.properties.properties.properties.type.type, "INTEGER");
	assert.deepEqual(result.properties.items.items.type, ["STRING", "NULL"]);
	assert.equal(result.properties.__proto__.type, "BOOLEAN");
	assert.equal(Object.hasOwn(result.properties, "__proto__"), true);
	assert.equal(result.properties.$id.type, "NUMBER");
	assert.equal(result.properties.$defs.type, "STRING");
	assert.equal(result.$defs.type.type, "STRING");
	assert.equal(result.$defs.node.type, "OBJECT");
	for (const key of ["description", "required", "default", "enum", "const", "examples", "x-custom", "$ref"]) assert.deepEqual(result[key], original[key]);
	assert.deepEqual(schema, original);
});

test("schema traversal handles combinators, tuple schemas, dependencies and boolean schemas", () => {
	const schema = {
		allOf: [{ type: "object" }], anyOf: [{ type: "string" }, { type: "null" }], oneOf: [{ type: "number" }],
		not: { type: "boolean" }, if: { type: "integer" }, then: { type: "string" }, else: false,
		items: [{ type: "integer" }], prefixItems: [{ type: "boolean" }], contains: { type: "string" },
		additionalProperties: { type: "number" }, unevaluatedProperties: true, propertyNames: { type: "string" },
		patternProperties: { type: { type: "boolean" } }, dependentSchemas: { type: { type: "object" } },
		dependencies: { type: ["type", "string"], value: { type: "number" } }, definitions: { type: { type: "array" } },
	};
	const result = uppercaseSchemaTypes(schema) as typeof schema;
	assert.equal(result.allOf[0]!.type, "OBJECT");
	assert.deepEqual(result.anyOf, [{ type: "STRING" }, { type: "NULL" }]);
	assert.equal(result.oneOf[0]!.type, "NUMBER");
	assert.equal(result.not.type, "BOOLEAN");
	assert.equal(result.if.type, "INTEGER");
	assert.equal(result.then.type, "STRING");
	assert.equal(result.else, false);
	assert.equal(result.items[0]!.type, "INTEGER");
	assert.equal(result.prefixItems[0]!.type, "BOOLEAN");
	assert.equal(result.contains.type, "STRING");
	assert.equal(result.additionalProperties.type, "NUMBER");
	assert.equal(result.unevaluatedProperties, true);
	assert.equal(result.propertyNames.type, "STRING");
	assert.equal(result.patternProperties.type.type, "BOOLEAN");
	assert.equal(result.dependentSchemas.type.type, "OBJECT");
	assert.deepEqual(result.dependencies.type, ["type", "string"]);
	assert.deepEqual(result.dependencies.value, { type: "NUMBER" });
	assert.equal(result.definitions.type.type, "ARRAY");
	assert.equal(uppercaseSchemaTypes(true), true);
});

test("tool declarations use parameters and one declaration per container without sanitizer data loss", () => {
	const parameters = JSON.parse('{"type":"object","properties":{"$id":{"type":"string"},"$defs":{"type":"number"},"__proto__":{"type":"boolean"}},"anyOf":[{"type":"object"}]}');
	const context = normalizeContext({ tools: [tool, { ...tool, name: "schema_test", parameters }], messages: [user()] });
	const result = buildRequest(model, context, undefined, route, identity);
	assert.equal(result.request.tools.length, 2);
	assert.ok(result.request.tools.every((entry) => entry.functionDeclarations.length === 1));
	assert.equal(result.request.tools[0]!.functionDeclarations[0]!.description, tool.description);
	assert.equal(result.request.tools[0]!.functionDeclarations[0]!.parametersJsonSchema, undefined);
	assert.deepEqual(result.request.tools[1]!.functionDeclarations[0]!.parameters, uppercaseSchemaTypes(parameters));
});

test("legacy schema metadata is stripped only at schema positions and references fail visibly", () => {
	const parameters = {
		$schema: "synthetic-schema-uri", $id: "synthetic-id", $defs: { unused: { type: "string" } },
		type: "object", properties: { $id: { type: "string" }, $defs: { type: "number" } },
		default: { $id: "literal-id", $defs: { type: "string" } },
		anyOf: [{ type: "object", $comment: "Schema metadata", properties: { $comment: { type: "string" } } }],
	};
	const context = normalizeContext({ tools: [{ ...tool, parameters }], messages: [user()] });
	const result = buildRequest(model, context, undefined, route, identity);
	assert.deepEqual(result.request.tools[0]!.functionDeclarations[0]!.parameters, {
		type: "OBJECT", properties: { $id: { type: "STRING" }, $defs: { type: "NUMBER" } },
		default: parameters.default,
		anyOf: [{ type: "OBJECT", properties: { $comment: { type: "STRING" } } }],
	});
	for (const schema of [{ $ref: "#/$defs/node", $defs: { node: { type: "string" } } }, { type: "array", items: { $dynamicRef: "#node" } }]) {
		const referenced = normalizeContext({ tools: [{ ...tool, parameters: schema }], messages: [user()] });
		assert.throws(() => buildRequest(model, referenced, undefined, route, identity), /do not support schema references/);
	}
});

test("Claude routes send the original JSON Schema while Gemini and GPT-OSS keep the legacy encoding", () => {
	const parameters = {
		type: "object", required: ["pattern"],
		properties: {
			pattern: { type: "string", minLength: 1 },
			exclude: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }], description: "Paths to skip" },
			limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
		},
	};
	const context = normalizeContext({ tools: [{ ...tool, name: "grep", parameters }], messages: [user()] });
	const before = structuredClone(context);
	for (const runtimeId of ["claude-sonnet-5-5-low", "claude-opus-5-5-high"]) {
		const claude = { ...model, id: runtimeId.replace(/-(low|high)$/, "") };
		const declaration = buildRequest(claude, context, undefined, { runtimeId, modelEnum: "MODEL_SYNTHETIC_CLAUDE", thinkingLevel: "LOW" }, identity)
			.request.tools[0]!.functionDeclarations[0]!;
		assert.deepEqual(Object.keys(declaration).sort(), ["description", "name", "parametersJsonSchema"]);
		assert.deepEqual(declaration.parametersJsonSchema, parameters);
		// The payload owns its copy: mutating it must not reach the transcript.
		(declaration.parametersJsonSchema as { required: string[] }).required.push("mutated");
	}
	for (const selected of [route, { runtimeId: "gpt-oss-120b-medium", modelEnum: "MODEL_SYNTHETIC_GPT", thinkingLevel: "MEDIUM" } as RequestRoute]) {
		const declaration = buildRequest(model, context, undefined, selected, identity).request.tools[0]!.functionDeclarations[0]!;
		assert.equal(declaration.parametersJsonSchema, undefined);
		assert.deepEqual(declaration.parameters, uppercaseSchemaTypes(parameters));
	}
	assert.deepEqual(context, before);
});

test("public converter retains same-model call IDs and signatures including empty text parts", () => {
	const context = deepFreeze(roundTrip());
	const before = structuredClone(context);
	const result = buildRequest(model, context, { reasoning: "low" }, route, identity);
	assert.deepEqual(result.request.contents[1]!.parts, [
		{ thought: true, text: "", thoughtSignature: "dGhpbmtpbmc=" },
		{ functionCall: { name: "read", args: { path: "sample.txt" }, id: "call_1" }, thoughtSignature: "Y2FsbA==" },
		{ text: "", thoughtSignature: "ZmluYWw=" },
	]);
	assert.equal(result.request.contents[2]!.parts![0]!.functionResponse!.id, "call_1");
	assert.equal(result.request.contents[2]!.role, "model");
	assert.equal(result.request.labels.last_step_index, "2");
	assert.deepEqual(context, before);
});

test("keeps normal user turn boundaries next to Gemini function responses", () => {
	const context = roundTrip();
	context.messages.push(user("A separate user turn"));
	const result = buildRequest(model, context, undefined, route, identity);
	assert.deepEqual(result.request.contents.map((content) => content.role), ["user", "model", "model", "user"]);
	assert.equal(result.request.contents.at(-1)!.parts![0]!.text, "A separate user turn");
});

test("does not generalize verified Gemini result role to unverified runtimes", () => {
	for (const runtimeId of ["gemini-3.8-flash-high", "gemini-4-argon-high", "gemini-3-pro-low", "gemini-3.8-flash-low-preview"]) {
		const result = buildRequest(model, roundTrip(), undefined, { ...route, runtimeId }, identity);
		assert.equal(result.request.contents[2]!.role, "user", runtimeId);
	}
});

test("Claude result role remains user with paired IDs and Claude labels", () => {
	const claude = { ...model, id: "claude-sonnet-5-5" };
	const claudeRoute: RequestRoute = { runtimeId: "claude-sonnet-5-5-low", modelEnum: "MODEL_SYNTHETIC_CLAUDE", thinkingLevel: "LOW" };
	const result = buildRequest(claude, roundTrip(claude), undefined, claudeRoute, identity);
	assert.equal(result.request.contents[2]!.role, "user");
	assert.equal(result.request.contents[1]!.parts![1]!.functionCall!.id, "call_1");
	assert.equal(result.request.contents[2]!.parts![0]!.functionResponse!.id, "call_1");
	for (const key of ["used_claude", "used_claude_conservative", "used_non_gemini_model"] as const) assert.equal(result.request.labels[key], "true");
});

test("multiple tool calls keep separate arguments, signatures and response IDs", () => {
	const context = normalizeContext({ messages: [
		user(),
		assistant([
			{ type: "toolCall", id: "call_a", name: "read", arguments: { path: "a" }, thoughtSignature: "YQ==" },
			{ type: "toolCall", id: "call_b", name: "read", arguments: { path: "b" }, thoughtSignature: "Yg==" },
		]),
		{ role: "toolResult", toolCallId: "call_b", toolName: "read", content: [{ type: "text", text: "B failed" }], isError: true, timestamp: 3 },
		{ role: "toolResult", toolCallId: "call_a", toolName: "read", content: [{ type: "text", text: "A" }], isError: false, timestamp: 4 },
	] });
	const result = buildRequest(model, context, undefined, route, identity);
	assert.deepEqual(result.request.contents[1]!.parts!.map((part) => [part.functionCall!.id, part.thoughtSignature]), [["call_a", "YQ=="], ["call_b", "Yg=="]]);
	assert.deepEqual(result.request.contents[2]!.parts!.map((part) => part.functionResponse), [
		{ name: "read", id: "call_b", response: { error: "B failed" } },
		{ name: "read", id: "call_a", response: { output: "A" } },
	]);
});

test("uses public cross-provider normalization without replaying foreign signatures", () => {
	const context = roundTrip({ ...model, api: "other-api", provider: "other-provider", id: "foreign-model" });
	const foreign = context.messages.find((message) => message.role === "assistant") as AssistantMessage;
	const call = foreign.content.find((block) => block.type === "toolCall")!;
	assert.equal(call.type, "toolCall");
	if (call.type === "toolCall") call.id = "foreign|call";
	const toolResult = context.messages.find((message) => message.role === "toolResult")!;
	if (toolResult.role === "toolResult") toolResult.toolCallId = "foreign|call";
	const result = buildRequest(model, context, undefined, route, identity);
	assert.deepEqual(result.request.contents[1]!.parts, [{ functionCall: { name: "read", args: { path: "sample.txt" }, id: "foreign_call" } }]);
	assert.equal(result.request.contents[2]!.parts![0]!.functionResponse!.id, "foreign_call");
	assert.equal(JSON.stringify(result.request.contents).includes("thoughtSignature"), false);
});

test("public converter behavior for invalid signatures, interrupted calls and aborted history is retained", () => {
	const context = normalizeContext({ messages: [
		user(), assistant([{ type: "toolCall", name: "read", id: "orphan", arguments: {}, thoughtSignature: "not base64" }]),
		{ ...assistant([{ type: "text", text: "Partial aborted output" }]), stopReason: "aborted" }, user("Continue"),
	] });
	const converted = convertMessages(model as Model<"google-generative-ai">, context);
	const result = buildRequest(model, context, undefined, { ...route, runtimeId: "gemini-4-argon-high", thinkingLevel: "HIGH" }, identity);
	assert.deepEqual(result.request.contents, converted);
	assert.equal(JSON.stringify(result.request.contents).includes("Partial aborted output"), false);
	assert.equal(JSON.stringify(result.request.contents).includes("No result provided"), true);
	assert.equal(JSON.stringify(result.request.contents).includes("not base64"), false);
});

test("images and multimodal tool results remain in the public converter structure", () => {
	const context = roundTrip();
	context.messages.unshift({ role: "user", content: [{ type: "text", text: "Inspect" }, { type: "image", mimeType: "image/png", data: "c3ludGhldGlj" }], timestamp: 0 });
	const resultMessage = context.messages.find((message) => message.role === "toolResult")!;
	if (resultMessage.role === "toolResult") resultMessage.content.push({ type: "image", mimeType: "image/jpeg", data: "aW1hZ2U=" });
	const result = buildRequest(model, context, undefined, route, identity);
	assert.deepEqual(result.request.contents[0]!.parts![1], { inlineData: { mimeType: "image/png", data: "c3ludGhldGlj" } });
	assert.deepEqual(result.request.contents.at(-1)!.parts![0]!.functionResponse!.parts, [{ inlineData: { mimeType: "image/jpeg", data: "aW1hZ2U=" } }]);
});

test("returned payloads do not share mutable arguments or schema literals with transcript", () => {
	const context = roundTrip();
	const result = buildRequest(model, context, undefined, route, identity);
	result.request.contents[1]!.parts![1]!.functionCall!.args!.path = "modified";
	(result.request.tools[0]!.functionDeclarations[0]!.parameters as { required: string[] }).required.push("modified");
	const rebuilt = buildRequest(model, context, undefined, route, identity);
	assert.equal(rebuilt.request.contents[1]!.parts![1]!.functionCall!.args!.path, "sample.txt");
	assert.deepEqual((rebuilt.request.tools[0]!.functionDeclarations[0]!.parameters as { required: string[] }).required, ["path"]);
});

test("FNV matches independent standard vectors and UTF-8 byte hashing", () => {
	assert.equal(fnvSessionId(), "-3750763034362895579");
	assert.equal(createHash("sha256").update(fnvSessionId()).digest("hex").slice(0, 16), "cfca81ad0e596bc7");
	assert.equal(fnvSessionId("a"), BigInt.asIntN(64, 0xaf63dc4c8601ec8cn).toString());
	assert.equal(fnvSessionId("foobar"), BigInt.asIntN(64, 0x85944171f73967e8n).toString());
	assert.equal(fnvSessionId("中文🙂"), fnvSessionId(new TextEncoder().encode("中文🙂")));
	assert.notEqual(fnvSessionId("a\0b"), fnvSessionId("ab"));
});

test("session identity is reproducible across resume and isolated across sessions and forks", () => {
	assert.deepEqual(createSessionIdentity("session-a"), createSessionIdentity("session-a"));
	assert.deepEqual(createSessionIdentity("中文/session"), createSessionIdentity("中文/session"));
	assert.notDeepEqual(createSessionIdentity("session-a"), createSessionIdentity("session-a/fork"));
	assert.notDeepEqual(createSessionIdentity(), createSessionIdentity());
	assert.notEqual(session.cascadeId, session.trajectoryId);
	assert.equal(session.cascadeId, session.rootCascadeId);
	assert.ok(Object.isFrozen(session));
	assert.throws(() => createSessionIdentity(""), /empty/);
});

test("concurrent same-session attempts have unique request identities without shared counters", async () => {
	const identities = await Promise.all(Array.from({ length: 64 }, async () => createRequestIdentity(session, "synthetic-project", { timestamp: 1800000000000 })));
	const payloads = identities.map((attempt) => buildRequest(model, roundTrip(), undefined, route, attempt));
	assert.equal(new Set(payloads.map((payload) => payload.requestId)).size, 64);
	assert.equal(new Set(payloads.map((payload) => payload.request.labels.request_id)).size, 64);
	assert.equal(new Set(payloads.map((payload) => payload.request.labels.cascade_id)).size, 1);
	assert.equal(new Set(payloads.map((payload) => payload.request.labels.trajectory_id)).size, 1);
	assert.ok(identities.every(Object.isFrozen));
	assert.deepEqual(buildRequest(model, roundTrip(), undefined, route, identities[0]!), payloads[0]);
});

test("explicit resumed step/index survive compaction while new attempts stay unique", () => {
	const restored = JSON.parse(JSON.stringify(session));
	const resumed = createRequestIdentity(restored, "synthetic-project", { step: 42, requestIndex: 17, timestamp: 1800000000001 });
	const result = buildRequest(model, normalizeContext({ messages: [user("Compacted summary")] }), undefined, route, resumed);
	assert.equal(result.request.labels.last_step_index, "42");
	assert.equal(result.request.labels.request_id, `${resumed.requestUuid}-17`);
	assert.ok(result.requestId.endsWith("/42"));
	assert.equal(result.request.labels.trajectory_id, session.trajectoryId);
	assert.notEqual(resumed.requestUuid, createRequestIdentity(restored, "synthetic-project", { step: 42, requestIndex: 17 }).requestUuid);
});

test("session metadata is independent of model switching and FNV sessionId", () => {
	const first = buildRequest(model, roundTrip(), undefined, route, identity);
	const second = buildRequest(model, roundTrip(), undefined, { ...route, runtimeId: "claude-opus-5-5-high", thinkingLevel: "HIGH" }, identity);
	assert.equal(first.request.labels.cascade_id, second.request.labels.cascade_id);
	assert.equal(first.request.labels.trajectory_id, second.request.labels.trajectory_id);
	const another = createRequestIdentity(createSessionIdentity("another-session"), "synthetic-project");
	assert.equal(buildRequest(model, roundTrip(), { sessionId: "NOT_THE_FNV_SEED" }, route, another).request.sessionId, first.request.sessionId);
});

test("thinking tiers and sampling are explicit, with no model or thinking downgrade", () => {
	const context = normalizeContext({ messages: [user()] });
	const high: RequestRoute = { runtimeId: "gemini-4-argon-high", modelEnum: "MODEL_SYNTHETIC_ARGON", thinkingLevel: "HIGH" };
	const result = buildRequest(model, context, { reasoning: "high", maxTokens: 123, temperature: 0 }, high, identity);
	assert.equal(result.model, "gemini-4-argon-high");
	assert.deepEqual(result.request.generationConfig, { maxOutputTokens: 123, temperature: 0, thinkingConfig: { includeThoughts: true, thinkingLevel: "HIGH" } });
	const xhighModel = { ...model, thinkingLevelMap: { low: "low", medium: "medium", high: "high", xhigh: "xhigh" } };
	const xhighRoute: RequestRoute = { runtimeId: "gemini-4-hydrogen-xhigh", modelEnum: "MODEL_SYNTHETIC_HYDROGEN", thinkingLevel: "XHIGH" };
	const xhighResult = buildRequest(xhighModel, context, { reasoning: "xhigh", maxTokens: 256 }, xhighRoute, identity);
	assert.equal(xhighResult.model, "gemini-4-hydrogen-xhigh");
	assert.deepEqual(xhighResult.request.generationConfig, { maxOutputTokens: 256, thinkingConfig: { includeThoughts: true, thinkingLevel: "XHIGH" } });
	for (const reasoning of ["off", "high", "max", "xhigh"] as const) assert.throws(() => buildRequest(model, context, { reasoning }, route, identity), /does not match/);
	assert.throws(() => buildRequest(model, context, { thinkingBudgets: { low: 123 } }, route, identity), /not token budgets/);
	assert.throws(() => buildRequest(model, context, undefined, { ...route, thinkingLevel: "MAX" } as unknown as RequestRoute, identity), /Unsupported/);
	assert.throws(() => buildRequest(model, context, undefined, { ...route, runtimeId: "" }, identity), /catalog/);
});

test("explicit catalog thinking maps are honored without inventing off or max support", () => {
	const context = normalizeContext({ messages: [user()] });
	const mapped = { ...model, thinkingLevelMap: { minimal: "LOW", low: route.runtimeId, high: null } };
	assert.equal(buildRequest(mapped, context, { reasoning: "minimal" }, route, identity).request.generationConfig.thinkingConfig!.thinkingLevel, "LOW");
	assert.equal(buildRequest(mapped, context, { reasoning: "low" }, route, identity).model, route.runtimeId);
	assert.throws(() => buildRequest(mapped, context, { reasoning: "high" }, route, identity), /does not match/);
});

test("nonthinking routes omit thinkingConfig and accept only absent or off reasoning", () => {
	const context = normalizeContext({ messages: [user()] });
	const nonthinking = { ...model, reasoning: false };
	const plainRoute: RequestRoute = { runtimeId: "synthetic-nonthinking", modelEnum: "MODEL_SYNTHETIC_PLAIN" };
	for (const options of [undefined, {}, { reasoning: "off" } as const]) {
		const result = buildRequest(nonthinking, context, options, plainRoute, identity);
		assert.equal(Object.hasOwn(result.request.generationConfig, "thinkingConfig"), false);
		assert.equal(result.model, plainRoute.runtimeId);
	}
	assert.throws(() => buildRequest(nonthinking, context, { reasoning: "low" }, plainRoute, identity), /only accept reasoning off/);
	assert.throws(() => buildRequest(nonthinking, context, undefined, route, identity), /must not supply a thinking tier/);
	assert.throws(() => buildRequest(model, context, undefined, plainRoute, identity), /missing CLI thinking tier/);
});

test("tool choice uses the public mapping and does not remove declarations", () => {
	for (const toolChoice of ["none", "auto"] as const) {
		const result = buildRequest(model, roundTrip(), { toolChoice }, route, identity);
		assert.equal(result.request.toolConfig!.functionCallingConfig.mode, toolChoice.toUpperCase());
		assert.equal(result.request.tools.length, 1);
	}
});

test("invalid request limits, identity counters and required strict schemas fail visibly", () => {
	const context = normalizeContext({ messages: [user()] });
	for (const maxTokens of [0, -1, 1.5, Infinity, model.maxTokens + 1]) assert.throws(() => buildRequest(model, context, { maxTokens }, route, identity), /maxTokens/);
	for (const temperature of [-1, NaN, Infinity]) assert.throws(() => buildRequest(model, context, { temperature }, route, identity), /temperature/);
	for (const options of [{ requestIndex: -1 }, { step: 1.5 }, { timestamp: NaN }, { step: Number.MAX_SAFE_INTEGER + 1 }]) assert.throws(() => createRequestIdentity(session, "synthetic-project", options));
	assert.throws(() => createRequestIdentity(session, " "), /Project ID/);
	assert.throws(() => buildRequest(model, context, undefined, route, { ...identity, cascadeId: "not-a-uuid" }), /UUID/);
	const strict = normalizeContext({ tools: [{ ...tool, constrainedSampling: { type: "json_schema", strict: "require" } }], messages: [user()] });
	assert.throws(() => buildRequest(model, strict, undefined, route, identity), /strict tools are unsupported/);
});

test("serialization never invokes transport hooks, consumes credentials or emits execution IDs", () => {
	const fail = () => { throw new Error("Transport hook called by serializer"); };
	const options: SimpleStreamOptions = { apiKey: "SYNTHETIC_NOT_A_SECRET", onPayload: fail, onResponse: fail, onProviderStreamEvent: fail, fetch: fail, env: { TEST: "NOT_FOR_PAYLOAD" } };
	const context = normalizeContext({ messages: [] });
	const result = buildRequest(model, context, options, route, identity);
	assert.deepEqual(result.request.contents, []);
	assert.ok(!JSON.stringify(result).includes("SYNTHETIC_NOT_A_SECRET"));
	assert.ok(!JSON.stringify(result).includes("NOT_FOR_PAYLOAD"));
	assert.ok(!JSON.stringify(result).includes("last_execution_id"));
});
