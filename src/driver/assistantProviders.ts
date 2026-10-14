/**
 * Streaming chat providers — Google Gemini and Anthropic Claude, both with
 * function/tool calling. Ported from turees' aiTuslakhRoute.js (the same
 * assistant feature, there for a rental-management system); the streaming,
 * retry and error-classification logic is reused near verbatim since it is
 * already hardened against the quirks of both APIs — only the domain content
 * around it (prompt, tools) is new.
 */
import { env } from '../config/env';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ToolCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult extends ToolCall {
  json: string;
}

export interface Provider {
  /** The model actually used for this call — may differ from the one requested, once a fallback kicks in. */
  readonly model: string;
  /** Streams text to `write`, and returns any tool calls the model asked for. */
  run(signal: AbortSignal, write: (text: string) => void): Promise<{ toolCalls: ToolCall[] }>;
  /** Folds the model's own turn and the tool results back into the conversation before the next round. */
  addToolResults(results: ToolResult[]): void;
}

export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: unknown;
}

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

/** How long an upstream call may take before its first byte, in ms — after
 * that it is aborted and (for Gemini) a lighter fallback model is tried. */
const FIRST_BYTE_TIMEOUT_MS = 20_000;

class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

async function callUpstream(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
): Promise<Response> {
  const inner = new AbortController();
  const onAbort = () => inner.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => inner.abort(), FIRST_BYTE_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(url, { method: 'POST', signal: inner.signal, headers, body: JSON.stringify(body) });
  } catch (err) {
    if (!signal.aborted && inner.signal.aborted) {
      throw new UpstreamError('AI хариу хугацаандаа ирсэнгүй', 504);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok || !resp.body) {
    const text = await resp.text().catch(() => '');
    throw new UpstreamError(text, resp.status);
  }
  return resp;
}

/** Reads an `event-stream` body line by line, yielding each `data:` payload as parsed JSON. */
async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      try {
        yield JSON.parse(line.slice(5).trim());
      } catch {
        // A partial line straddling two chunks; next chunk completes it.
      }
    }
  }
}

function thinkingConfigFor(model: string): Record<string, unknown> | null {
  if (/2\.5-flash/i.test(model)) return { thinkingBudget: 0 };
  if (/flash/i.test(model) && !/lite/i.test(model)) return { thinkingLevel: 'low' };
  return null;
}

export function geminiProvider(
  key: string,
  systemText: string,
  messages: ChatMessage[],
  tools: ToolDeclaration[] | null,
): Provider {
  const requestedModel = env.ASSISTANT_MODEL || 'gemini-flash-latest';
  const fallbackModel =
    env.ASSISTANT_FALLBACK_MODEL && env.ASSISTANT_FALLBACK_MODEL !== requestedModel
      ? env.ASSISTANT_FALLBACK_MODEL
      : null;

  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  let lastParts: Array<Record<string, unknown>> = [];
  const noThinkingModels = new Set<string>();
  let usedModel = requestedModel;

  return {
    get model() {
      return usedModel;
    },
    async run(signal, write) {
      const request = (model: string) => {
        const thinking = noThinkingModels.has(model) ? null : thinkingConfigFor(model);
        return callUpstream(
          `${GEMINI_URL}/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
          { 'content-type': 'application/json', 'x-goog-api-key': key },
          {
            systemInstruction: { parts: [{ text: systemText }] },
            contents,
            ...(tools ? { tools: [{ functionDeclarations: tools }], toolConfig: { functionCallingConfig: { mode: 'AUTO' } } } : {}),
            generationConfig: {
              maxOutputTokens: 2048,
              temperature: 0.3,
              ...(thinking ? { thinkingConfig: thinking } : {}),
            },
          },
          signal,
        );
      };

      let resp: Response | undefined;
      let lastError: unknown;
      const attempts = [requestedModel];
      for (let i = 0; i < attempts.length; i++) {
        const model = attempts[i];
        try {
          resp = await request(model);
          usedModel = model;
          break;
        } catch (err) {
          lastError = err;
          if (signal.aborted) throw err;
          const status = err instanceof UpstreamError ? err.status : undefined;
          // The model rejected thinkingConfig outright — retry once without it.
          if (status === 400 && /thinking/i.test(String((err as Error).message)) && thinkingConfigFor(model)) {
            noThinkingModels.add(model);
            attempts.splice(i + 1, 0, model);
            continue;
          }
          const overloaded = status === 503 || status === 500 || status === 504;
          const quota = status === 429;
          if (overloaded && i === 0) attempts.push(requestedModel);
          if ((overloaded || quota) && fallbackModel && !attempts.includes(fallbackModel)) {
            attempts.push(fallbackModel);
          }
          if (i === attempts.length - 1) throw err;
          if (overloaded) await new Promise((r) => setTimeout(r, 800));
        }
      }
      if (!resp) throw lastError instanceof Error ? lastError : new Error('AI хариу алга');

      const parts: Array<Record<string, unknown>> = [];
      const toolCalls: ToolCall[] = [];
      for await (const event of readSse(resp.body!)) {
        if (event.error) throw new UpstreamError(JSON.stringify(event.error), 502);
        const candidateParts =
          ((event.candidates as Array<{ content?: { parts?: Array<Record<string, unknown>> } }> | undefined)?.[0]
            ?.content?.parts as Array<Record<string, unknown>> | undefined) ?? [];
        for (const p of candidateParts) {
          parts.push(p);
          const fn = p.functionCall as { id?: string; name: string; args?: Record<string, unknown> } | undefined;
          if (fn) toolCalls.push({ id: fn.id, name: fn.name, args: fn.args ?? {} });
          else if (typeof p.text === 'string' && !p.thought) write(p.text);
        }
      }
      lastParts = parts;
      return { toolCalls };
    },
    addToolResults(results) {
      contents.push({ role: 'model', parts: lastParts as never });
      contents.push({
        role: 'user',
        parts: results.map((r) => ({
          functionResponse: { ...(r.id ? { id: r.id } : {}), name: r.name, response: { result: JSON.parse(r.json) } },
        })) as never,
      });
    },
  };
}

interface AnthropicBlock {
  type: 'text' | 'tool_use';
  id?: string;
  name?: string;
  text?: string;
  input?: Record<string, unknown>;
  _json?: string;
}

export function anthropicProvider(
  key: string,
  systemText: string,
  messages: ChatMessage[],
  tools: ToolDeclaration[] | null,
): Provider {
  const model = env.ASSISTANT_MODEL || 'claude-sonnet-5';
  const msgs: Array<{ role: string; content: unknown }> = messages.map((m) => ({ role: m.role, content: m.content }));
  let lastBlocks: AnthropicBlock[] = [];

  return {
    model,
    async run(signal, write) {
      const resp = await callUpstream(
        ANTHROPIC_URL,
        { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        {
          model,
          max_tokens: 2048,
          stream: true,
          system: [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }],
          ...(tools
            ? {
                tools: tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  input_schema: t.parameters,
                })),
              }
            : {}),
          messages: msgs,
        },
        signal,
      );

      const blocks: AnthropicBlock[] = [];
      for await (const event of readSse(resp.body!)) {
        if (event.type === 'error') throw new UpstreamError(JSON.stringify(event.error), 502);
        if (event.type === 'content_block_start') {
          const b = (event.content_block ?? {}) as { type?: string; id?: string; name?: string };
          blocks[event.index as number] =
            b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, _json: '' } : { type: 'text', text: '' };
        } else if (event.type === 'content_block_delta') {
          const b = blocks[event.index as number];
          if (!b) continue;
          const delta = event.delta as { type?: string; text?: string; partial_json?: string } | undefined;
          if (delta?.type === 'text_delta' && delta.text) {
            b.text = (b.text ?? '') + delta.text;
            write(delta.text);
          } else if (delta?.type === 'input_json_delta') {
            b._json = (b._json ?? '') + (delta.partial_json ?? '');
          }
        }
      }

      lastBlocks = blocks
        .filter(Boolean)
        .map((b) => {
          if (b.type !== 'tool_use') return b;
          let input: Record<string, unknown> = {};
          try {
            input = b._json ? JSON.parse(b._json) : {};
          } catch {
            // Empty input rather than a crash on a malformed partial payload.
          }
          return { ...b, input };
        })
        .filter((b) => b.type !== 'text' || b.text);

      const toolCalls = lastBlocks
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({ id: b.id, name: b.name!, args: b.input ?? {} }));
      return { toolCalls };
    },
    addToolResults(results) {
      msgs.push({ role: 'assistant', content: lastBlocks });
      msgs.push({
        role: 'user',
        content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.json })),
      });
    },
  };
}

/** A driver-facing explanation for why the assistant could not answer. */
export function describeError(err: unknown): string {
  const status = err instanceof UpstreamError ? err.status : undefined;
  const parsed = parseUpstreamError(err);
  const msg = String(parsed?.message ?? '').toLowerCase();
  const kind = String(parsed?.status ?? '');

  const quotaExhausted =
    status === 429 || kind === 'RESOURCE_EXHAUSTED' || msg.includes('quota') || msg.includes('rate limit') || msg.includes('credit balance');
  if (quotaExhausted) {
    if (msg.includes('credit balance')) return 'AI туслахын төлбөрийн үлдэгдэл дууссан байна.';
    return 'AI туслах одоогоор ачаалал ихтэй байна. Хэдэн минутын дараа дахин оролдоно уу.';
  }
  if (status === 401 || status === 403 || kind === 'PERMISSION_DENIED' || kind === 'UNAUTHENTICATED') {
    return 'AI туслахын тохиргоонд алдаа гарлаа. Дэмжлэгт мэдэгдэнэ үү.';
  }
  if (status === 404) return 'AI туслах одоогоор ашиглах боломжгүй байна.';
  if (status === 503 || status === 529 || status === 500) {
    return 'AI туслахын сервер түр ачаалалтай байна. Хэдэн минутын дараа дахин оролдоно уу.';
  }
  return 'AI туслахтай холбогдож чадсангүй. Дахин оролдоно уу.';
}

function parseUpstreamError(err: unknown): { message?: string; status?: string } | null {
  try {
    const parsed: unknown = JSON.parse(String((err as Error)?.message ?? ''));
    const obj = Array.isArray(parsed) ? parsed[0] : parsed;
    return (obj as { error?: { message?: string; status?: string } })?.error ?? null;
  } catch {
    return null;
  }
}
