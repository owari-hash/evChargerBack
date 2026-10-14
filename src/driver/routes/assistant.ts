import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env';
import { getCurrentUser } from '../auth/session';
import { ASSISTANT_SYSTEM_PROMPT, pageHint } from '../assistantKnowledge';
import { ASSISTANT_TOOLS, runAssistantTool } from '../assistantTools';
import {
  anthropicProvider,
  describeError,
  geminiProvider,
  type ChatMessage,
  type Provider,
  type ToolResult,
} from '../assistantProviders';
import { DriverError, MINUTE, guard, route } from '../http';

/**
 * AI assistant for the kiosk web app and the Flutter app — plain Q&A about
 * Eplug plus, for a signed-in driver, read-only lookups of their own wallet
 * and charging history. Stateless: the client keeps the conversation and
 * resends it each turn, same as turees' aiTuslakh this was ported from.
 *
 *   POST /app-api/assistant   body: { messages: [{role, content}], page? }
 *
 * Streams the answer as plain chunked text (not SSE) so the widget can render
 * it token by token with nothing more than `fetch` + `response.body`.
 */
export const assistantRouter = Router();

const MAX_MESSAGES = 12;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_TOOL_ROUNDS = 3;
const OVERALL_TIMEOUT_MS = 60_000;

const bodySchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string(),
      }),
    )
    .default([]),
  page: z.string().trim().max(120).optional(),
});

function sanitiseMessages(raw: unknown): ChatMessage[] {
  const parsed = bodySchema.shape.messages.safeParse(raw);
  if (!parsed.success) return [];
  const trimmed = parsed.data
    .filter((m) => m.content.trim())
    .slice(-MAX_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content.trim().slice(0, MAX_MESSAGE_LENGTH) }));
  // Both providers require the conversation to start with a user turn.
  while (trimmed.length && trimmed[0].role !== 'user') trimmed.shift();
  return trimmed;
}

assistantRouter.post(
  '/',
  route(async (req, res) => {
    const geminiKey = env.GEMINI_API_KEY;
    const anthropicKey = env.ANTHROPIC_API_KEY;
    if (!geminiKey && !anthropicKey) {
      throw new DriverError(503, 'AI туслах тохируулагдаагүй байна.');
    }

    const body = bodySchema.safeParse(req.body ?? {});
    if (!body.success) throw new DriverError(400, 'Асуултаа дахин шалгана уу.');

    const messages = sanitiseMessages(req.body?.messages);
    if (!messages.length || messages[messages.length - 1].role !== 'user') {
      throw new DriverError(400, 'Асуултаа бичнэ үү.');
    }

    guard(req, 'assistant', env.ASSISTANT_RATE_LIMIT, 10 * MINUTE);

    const user = await getCurrentUser(req);
    const tools = user ? ASSISTANT_TOOLS : null;
    const systemText = [ASSISTANT_SYSTEM_PROMPT, pageHint(body.data.page)].filter(Boolean).join('\n\n');

    const provider: Provider = geminiKey
      ? geminiProvider(geminiKey, systemText, messages, tools)
      : anthropicProvider(anthropicKey!, systemText, messages, tools);

    const abort = new AbortController();
    let timedOut = false;
    const overallTimer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, OVERALL_TIMEOUT_MS);
    res.on('close', () => {
      clearTimeout(overallTimer);
      abort.abort();
    });

    let started = false;
    const write = (text: string) => {
      if (!text) return;
      if (!started) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('X-Accel-Buffering', 'no');
        started = true;
      }
      res.write(text);
    };

    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const { toolCalls } = await provider.run(abort.signal, write);
        if (!toolCalls.length || !user) break;

        const results: ToolResult[] = [];
        for (const call of toolCalls) {
          const data = await runAssistantTool(user, call.name, call.args);
          results.push({ ...call, json: JSON.stringify(data) });
        }
        provider.addToolResults(results);
        if (round === MAX_TOOL_ROUNDS - 1) {
          write('\n\n(Асуулт хэт нарийн байна — илүү тодорхой асууна уу.)');
        }
      }
    } catch (err) {
      clearTimeout(overallTimer);
      if (abort.signal.aborted) {
        if (timedOut) {
          const message = 'AI туслах хэт удаан хариулж байна. Асуултаа товчлоод дахин оролдоно уу.';
          if (!started) throw new DriverError(504, message);
          write(`\n\n(${message})`);
          res.end();
          return;
        }
        // The client disconnected; nothing left to write to.
        return;
      }
      const message = describeError(err);
      if (!started) throw new DriverError(502, message);
      write('\n\n(Хариу тасалдлаа. Дахин оролдоно уу.)');
      res.end();
      return;
    }

    clearTimeout(overallTimer);
    if (!started) {
      write('Уучлаарай, хариу гаргаж чадсангүй. Асуултаа өөрөөр асууна уу.');
    }
    res.end();
  }),
);
