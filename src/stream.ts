import { randomUUID } from "node:crypto";
import type {
  Api, AssistantMessage, AssistantMessageEventStream, JsonObject, Model, SimpleStreamOptions, TranscriptContext,
} from "@earendil-works/pi-ai";
import { calculateCost, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { CLIENT_USER_AGENT, DEFAULT_BASE_URL, assertOfficialBaseUrl } from "./client.ts";

export interface AntigravityStreamOptions extends SimpleStreamOptions {
  /** Response-header deadline, excluding payload building and hooks. Default: 30 seconds. */
  headTimeoutMs?: number;
  /** Deadline for each body read, excluding time spent in observer hooks. Default: 120 seconds. */
  idleTimeoutMs?: number;
}

export interface AntigravityStreamCredentials {
  token: string;
  baseUrl?: string;
}

export interface AntigravityStreamDependencies {
  buildPayload(model: Model<Api>, context: TranscriptContext, options: AntigravityStreamOptions): unknown | Promise<unknown>;
  resolveCredentials(model: Model<Api>, options: AntigravityStreamOptions): AntigravityStreamCredentials | Promise<AntigravityStreamCredentials>;
  fetch?: typeof globalThis.fetch;
}

/** Evidence is provider data, not a guessed quota/retry classification. Never logged here. */
export class AntigravityStreamError extends Error {
  constructor(message: string, readonly evidence: JsonObject = {}) {
    super(message);
    this.name = "AntigravityStreamError";
  }
}

const MAX_FRAME_CHARS = 4 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;

/** Incremental SSE framing. A partial data frame at EOF is an error, not a successful response. */
class SseDecoder {
  private decoder = new TextDecoder("utf-8", { fatal: true });
  private line = "";
  private data: string[] = [];
  private frameChars = 0;
  private skipLF = false;

  push(bytes: Uint8Array): string[] {
    return this.consume(this.decoder.decode(bytes, { stream: true }));
  }

  finish(): string[] {
    const frames = this.consume(this.decoder.decode());
    if (this.data.length || (this.line && !this.line.startsWith(":"))) {
      throw new AntigravityStreamError("Antigravity SSE ended with an incomplete frame");
    }
    return frames;
  }

  private consume(text: string): string[] {
    const frames: string[] = [];
    for (const char of text) {
      if (this.skipLF) {
        this.skipLF = false;
        if (char === "\n") continue;
      }
      if (++this.frameChars > MAX_FRAME_CHARS) throw new AntigravityStreamError("Antigravity SSE frame exceeds the size limit");
      if (char === "\r" || char === "\n") {
        if (char === "\r") this.skipLF = true;
        if (this.line === "") {
          if (this.data.length) frames.push(this.data.join("\n"));
          this.data = [];
          this.frameChars = 0;
        } else if (this.line === "data" || this.line.startsWith("data:")) {
          let value = this.line.slice(5);
          if (value.startsWith(" ")) value = value.slice(1);
          this.data.push(value);
        }
        this.line = "";
      } else {
        this.line += char;
      }
    }
    return frames;
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AntigravityStreamError(`Invalid Antigravity ${label}: expected an object`);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new AntigravityStreamError(`Invalid Antigravity ${label}: expected a string`);
  return value;
}

function deadline(value: number | undefined, fallback: number): number {
  const ms = value ?? fallback;
  if (!Number.isFinite(ms) || ms <= 0 || ms > 2 ** 31 - 1) {
    throw new AntigravityStreamError("Antigravity timeouts must be positive finite milliseconds within the timer range");
  }
  return ms;
}

/** Race even non-cooperative injected I/O/hooks against cancellation; always remove listeners/timers. */
async function waitFor<T>(work: PromiseLike<T> | T, controller: AbortController, timeoutMs?: number, phase?: string): Promise<T> {
  const signal = controller.signal;
  const promise = Promise.resolve(work);
  if (signal.aborted) {
    void promise.catch(() => {});
    signal.throwIfAborted();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => {};
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        if (timeoutMs !== undefined) {
          timer = setTimeout(() => controller.abort(new AntigravityStreamError(
            `Antigravity ${phase} timeout after ${timeoutMs}ms`, { phase: phase ?? "unknown", timeoutMs },
          )), timeoutMs);
        }
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
    clearTimeout(timer);
  }
}

/** One logical request, one fetch, no internal retry or endpoint failover. */
export function streamAntigravity(
  model: Model<Api>,
  context: TranscriptContext,
  options: AntigravityStreamOptions | undefined,
  dependencies: AntigravityStreamDependencies,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const output: AssistantMessage = {
    role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    timestamp: Date.now(), stopReason: "pending",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  const controller = new AbortController();
  const abort = () => controller.abort(options?.signal?.reason ?? new Error("Request aborted"));
  options?.signal?.addEventListener("abort", abort, { once: true });
  if (options?.signal?.aborted) abort();
  const effectiveOptions: AntigravityStreamOptions = { ...options, signal: controller.signal };

  void (async () => {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let currentIndex: number | undefined;
    let finishReason: string | undefined;
    const usage: Record<string, number> = {};
    const closeBlock = () => {
      if (currentIndex === undefined) return;
      const block = output.content[currentIndex]!;
      if (block.type === "text") stream.push({ type: "text_end", contentIndex: currentIndex, content: block.text, partial: output });
      if (block.type === "thinking") stream.push({ type: "thinking_end", contentIndex: currentIndex, content: block.thinking, partial: output });
      currentIndex = undefined;
    };
    const readUsage = (value: unknown) => {
      for (const [key, count] of Object.entries(object(value, "usageMetadata"))) {
        if (!["promptTokenCount", "candidatesTokenCount", "cachedContentTokenCount", "thoughtsTokenCount", "totalTokenCount"].includes(key)) continue;
        if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
          throw new AntigravityStreamError(`Invalid Antigravity usage counter: ${key}`);
        }
        usage[key] = count;
      }
      const rawCached = usage.cachedContentTokenCount ?? 0;
      const prompt = usage.promptTokenCount ?? rawCached;
      const cached = Math.min(rawCached, prompt);
      if (rawCached > prompt) {
        const details = { promptTokenCount: prompt, cachedContentTokenCount: rawCached };
        const existing = output.diagnostics?.find((d) => d.type === "antigravity.usage_clamped");
        if (existing) existing.details = details;
        else (output.diagnostics ??= []).push({ type: "antigravity.usage_clamped", timestamp: Date.now(), details });
      }
      output.usage.input = prompt - cached;
      output.usage.cacheRead = cached;
      output.usage.output = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
      if (usage.thoughtsTokenCount !== undefined) output.usage.reasoning = usage.thoughtsTokenCount;
      output.usage.totalTokens = usage.totalTokenCount ?? prompt + output.usage.output;
      calculateCost(model, output.usage);
    };
    const readPart = (value: unknown, explicitBoundary: boolean) => {
      const part = object(value, "part");
      const signature = optionalString(part.thoughtSignature, "thoughtSignature");
      if (part.functionCall !== undefined) {
        if (finishReason) throw new AntigravityStreamError("Antigravity sent a tool call after the finish reason");
        if (part.text !== undefined) throw new AntigravityStreamError("Antigravity part contains both text and functionCall");
        const call = object(part.functionCall, "functionCall");
        const name = optionalString(call.name, "functionCall.name");
        if (!name) throw new AntigravityStreamError("Antigravity function call has no name");
        const id = optionalString(call.id, "functionCall.id") || `agy_${randomUUID()}`;
        if (output.content.some((b) => b.type === "toolCall" && b.id === id)) {
          throw new AntigravityStreamError("Antigravity returned a duplicate function-call ID", { id });
        }
        const args = object(call.args ?? {}, "functionCall.args") as JsonObject;
        closeBlock();
        const toolCall = { type: "toolCall" as const, id, name, arguments: args,
          ...(signature ? { thoughtSignature: signature } : {}) };
        const contentIndex = output.content.push(toolCall) - 1;
        stream.push({ type: "toolcall_start", contentIndex, partial: output });
        stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(args), partial: output });
        stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
      } else if (part.text !== undefined) {
        const text = optionalString(part.text, "part.text")!;
        if (finishReason && text !== "") throw new AntigravityStreamError("Antigravity sent text after the finish reason");
        if (part.thought !== undefined && typeof part.thought !== "boolean") throw new AntigravityStreamError("Invalid Antigravity thought flag");
        const type = part.thought === true ? "thinking" : "text";
        // Separate explicit parts and every signed part. Unindexed, unsigned deltas in
        // later frames can extend the current block, but signatures never move to it.
        if (explicitBoundary || signature) closeBlock();
        if (currentIndex === undefined || output.content[currentIndex]!.type !== type) {
          closeBlock();
          currentIndex = output.content.push(type === "text" ? { type, text: "" } : { type, thinking: "" }) - 1;
          stream.push({ type: type === "text" ? "text_start" : "thinking_start", contentIndex: currentIndex, partial: output });
        }
        const block = output.content[currentIndex]!;
        if (block.type === "text") {
          block.text += text;
          if (signature) block.textSignature = signature;
          stream.push({ type: "text_delta", contentIndex: currentIndex, delta: text, partial: output });
        } else if (block.type === "thinking") {
          block.thinking += text;
          if (signature) block.thinkingSignature = signature;
          stream.push({ type: "thinking_delta", contentIndex: currentIndex, delta: text, partial: output });
        }
      } else {
        throw new AntigravityStreamError("Unsupported Antigravity response part", { keys: Object.keys(part) });
      }
    };
    const readEvent = async (data: string): Promise<boolean> => {
      if (data === "[DONE]") return true;
      let parsed: unknown;
      try { parsed = JSON.parse(data); } catch {
        throw new AntigravityStreamError("Antigravity SSE contains invalid JSON");
      }
      await waitFor(effectiveOptions.onProviderStreamEvent?.(parsed, model), controller);
      controller.signal.throwIfAborted();
      const envelope = object(parsed, "event");
      if (envelope.error !== undefined) {
        throw new AntigravityStreamError(`Antigravity stream error: ${JSON.stringify(envelope.error)}`, { body: envelope as JsonObject });
      }
      const response = object(envelope.response, "response");
      if (response.error !== undefined) {
        throw new AntigravityStreamError(`Antigravity stream error: ${JSON.stringify(response.error)}`, { body: envelope as JsonObject });
      }
      output.responseId ||= optionalString(response.responseId, "responseId") || undefined;
      output.responseModel ||= optionalString(response.modelVersion, "modelVersion") || undefined;
      // Keep upstream provenance without substituting the requested runtime model for a confirmed model.
      if (envelope.traceId !== undefined || envelope.metadata !== undefined) {
        const details: JsonObject = {};
        if (envelope.traceId !== undefined) details.traceId = optionalString(envelope.traceId, "traceId")!;
        if (envelope.metadata !== undefined) details.metadata = object(envelope.metadata, "metadata") as JsonObject;
        const existing = output.diagnostics?.find((d) => d.type === "antigravity.response");
        if (existing) existing.details = { ...existing.details, ...details };
        else (output.diagnostics ??= []).push({ type: "antigravity.response", timestamp: Date.now(), details });
      }
      if (response.usageMetadata !== undefined) readUsage(response.usageMetadata);
      if (response.promptFeedback !== undefined) {
        const feedback = object(response.promptFeedback, "promptFeedback");
        if (feedback.blockReason) throw new AntigravityStreamError("Antigravity blocked the prompt", { promptFeedback: feedback as JsonObject });
      }
      if (response.candidates !== undefined) {
        if (!Array.isArray(response.candidates) || response.candidates.length > 1) throw new AntigravityStreamError("Invalid Antigravity candidates");
        if (response.candidates.length) {
          const candidate = object(response.candidates[0], "candidate");
          if (candidate.index !== undefined && candidate.index !== 0) throw new AntigravityStreamError("Unsupported Antigravity candidate index");
          if (candidate.content !== undefined) {
            const content = object(candidate.content, "content");
            if (!Array.isArray(content.parts)) throw new AntigravityStreamError("Invalid Antigravity content.parts");
            for (let i = 0; i < content.parts.length; i++) readPart(content.parts[i], i > 0);
          }
          if (candidate.finishReason !== undefined) {
            const reason = optionalString(candidate.finishReason, "finishReason")!;
            if (finishReason && finishReason !== reason) throw new AntigravityStreamError("Conflicting Antigravity finish reasons");
            finishReason = reason;
            output.rawStopReason = reason;
            if (reason !== "STOP" && reason !== "MAX_TOKENS") {
              throw new AntigravityStreamError(`Antigravity stopped with: ${reason}`, { candidate: candidate as JsonObject });
            }
          }
        }
      }
      return false;
    };

    try {
      controller.signal.throwIfAborted();
      const headMs = deadline(options?.headTimeoutMs ?? options?.timeoutMs, 30_000);
      const idleMs = deadline(options?.idleTimeoutMs ?? options?.timeoutMs, 120_000);
      const credentials = await waitFor(dependencies.resolveCredentials(model, effectiveOptions), controller);
      if (!credentials.token) throw new AntigravityStreamError("Missing Antigravity access token");
      const baseUrl = assertOfficialBaseUrl(credentials.baseUrl ?? (model.baseUrl || DEFAULT_BASE_URL));
      let payload = await waitFor(dependencies.buildPayload(model, context, effectiveOptions), controller);
      const replacement = await waitFor(effectiveOptions.onPayload?.(payload, model), controller);
      if (replacement !== undefined) payload = replacement;
      controller.signal.throwIfAborted();
      const body = JSON.stringify(payload);
      if (body === undefined) throw new AntigravityStreamError("Antigravity payload is not JSON serializable");
      const headers = new Headers({ Authorization: `Bearer ${credentials.token}`, "Content-Type": "application/json", "User-Agent": CLIENT_USER_AGENT });
      for (const source of [model.headers, options?.headers]) {
        for (const [key, value] of Object.entries(source ?? {})) {
          if (value === null) headers.delete(key);
          else headers.set(key, value);
        }
      }
      const fetching = Promise.resolve((options?.fetch ?? dependencies.fetch ?? globalThis.fetch)(
        `${baseUrl}/v1internal:streamGenerateContent?alt=sse`,
        { method: "POST", redirect: "error", headers, body, signal: controller.signal },
      ));
      // An injected fetch might ignore abort and resolve late; do not leak its body.
      void fetching.then((response) => {
        if (controller.signal.aborted && !reader) void response.body?.cancel().catch(() => {});
      }, () => {});
      const response = await waitFor(fetching, controller, headMs, "response-header");
      reader = response.body?.getReader();
      await waitFor(effectiveOptions.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers) }, model), controller);
      if (!response.ok) {
        let text = "";
        let bytes = 0;
        const decoder = new TextDecoder();
        if (reader) {
          while (true) {
            const chunk = await waitFor(reader.read(), controller, idleMs, "body-idle");
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > MAX_ERROR_BYTES) throw new AntigravityStreamError(`Antigravity HTTP ${response.status}: error body exceeds the size limit`, { status: response.status });
            text += decoder.decode(chunk.value, { stream: true });
          }
        }
        text += decoder.decode();
        let errorBody: unknown = text;
        try { errorBody = JSON.parse(text); } catch { /* Preserve non-JSON HTTP evidence verbatim. */ }
        throw new AntigravityStreamError(`Antigravity HTTP ${response.status}: ${text || response.statusText}`, {
          status: response.status, body: errorBody as JsonObject | string,
          ...(response.headers.has("retry-after") ? { retryAfter: response.headers.get("retry-after")! } : {}),
        });
      }
      if (!reader) throw new AntigravityStreamError("Antigravity response has no body");
      if (!/^text\/event-stream(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) {
        throw new AntigravityStreamError("Antigravity response is not text/event-stream");
      }
      stream.push({ type: "start", partial: output });
      const sse = new SseDecoder();
      let done = false;
      while (!done) {
        const chunk = await waitFor(reader.read(), controller, idleMs, "body-idle");
        controller.signal.throwIfAborted();
        const frames = chunk.done ? sse.finish() : sse.push(chunk.value);
        for (const data of frames) {
          if (done) throw new AntigravityStreamError("Antigravity sent data after [DONE]");
          done = await readEvent(data);
        }
        if (chunk.done) break;
      }
      controller.signal.throwIfAborted();
      if (!finishReason) throw new AntigravityStreamError("Antigravity stream ended without a finish reason");
      closeBlock();
      output.stopReason = finishReason === "MAX_TOKENS" ? "length"
        : output.content.some((b) => b.type === "toolCall") ? "toolUse" : "stop";
      stream.push({ type: "done", reason: output.stopReason, message: output });
    } catch (error) {
      closeBlock();
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = output.stopReason === "aborted" ? "Antigravity request aborted"
        : error instanceof Error ? error.message : String(error);
      if (error instanceof AntigravityStreamError) {
        (output.diagnostics ??= []).push({ type: "antigravity.error", timestamp: Date.now(), details: error.evidence,
          error: { name: error.name, message: error.message } });
      }
      stream.push({ type: "error", reason: output.stopReason, error: output });
    } finally {
      options?.signal?.removeEventListener("abort", abort);
      // Do not let a broken source's cancellation promise hold the terminal result open.
      if (reader) {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      controller.abort();
      stream.end();
    }
  })();
  return stream;
}
