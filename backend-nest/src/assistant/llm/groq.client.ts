import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  LlmProvider,
  ModelFunctionCall,
  ModelTurn,
  StartParams,
  SubmitToolResultsParams,
  ToolDeclaration,
} from './llm.provider';

const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = 'openai/gpt-oss-120b';
/**
 * Reserved completion length.
 *
 * Groq charges max_tokens against the tokens-per-minute budget whether or not
 * the model uses it, so 4096 was silently costing half the per-minute budget on
 * every single call. An answer here is a paragraph and maybe a small table.
 */
const MAX_TOKENS = 1024;
const REQUEST_TIMEOUT_MS = 30_000;

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [300, 900];

/** How long an idle conversation is kept before it is dropped. */
const CONVERSATION_TTL_MS = 60 * 60 * 1000;
const MAX_CONVERSATIONS = 500;

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The subset of the OpenAI-compatible message shape this client uses. */
interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface StoredConversation {
  messages: ChatMessage[];
  touchedAt: number;
}

/**
 * Groq-backed implementation of the assistant's model provider.
 *
 * Groq serves open models behind an OpenAI-compatible API, and serves them
 * fast: a tool-selection turn lands in well under a second, against tens of
 * seconds on a throttled Gemini free tier.
 *
 * Like Claude, the API is stateless -- the whole history goes up each request --
 * so continuity lives here. The store is in-memory: Redis is disabled in this
 * deployment, and a lost conversation costs the thread of a chat, not data. It
 * does mean history is per-process; behind several instances, follow-up
 * questions would need sticky sessions or a shared store.
 */
@Injectable()
export class GroqClient implements LlmProvider {
  readonly providerName = 'groq';

  private readonly logger = new Logger(GroqClient.name);
  private readonly conversations = new Map<string, StoredConversation>();

  private get model(): string {
    return process.env.GROQ_MODEL || DEFAULT_MODEL;
  }

  isConfigured(): boolean {
    return Boolean(process.env.GROQ_API_KEY);
  }

  async start(params: StartParams): Promise<ModelTurn> {
    const conversationId = params.conversationId ?? randomUUID();
    const messages = this.load(conversationId);

    // The system prompt is only prepended once; it stays at the head of the
    // stored history for every later turn.
    if (messages.length === 0) {
      messages.push({ role: 'system', content: params.systemInstruction });
    }
    messages.push({ role: 'user', content: params.userMessage });

    return this.send(conversationId, messages, params.tools);
  }

  async submitToolResults(params: SubmitToolResultsParams): Promise<ModelTurn> {
    const messages = this.load(params.conversationId);

    // One tool message per call, each tied back by tool_call_id. A missing or
    // mismatched id makes the model re-request the same tool.
    for (const result of params.results) {
      messages.push({
        role: 'tool',
        tool_call_id: result.callId,
        content:
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result),
      });
    }

    return this.send(params.conversationId, messages, params.tools);
  }

  private async send(
    conversationId: string,
    messages: ChatMessage[],
    tools: ToolDeclaration[],
  ): Promise<ModelTurn> {
    const body = {
      model: this.model,
      max_tokens: MAX_TOKENS,
      messages,
      tools: tools.map((t) => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      })),
    };

    const message = await this.post(body);

    messages.push({
      role: 'assistant',
      content: message.content ?? null,
      ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}),
    });
    this.save(conversationId, messages);

    const calls: ModelFunctionCall[] = [];
    for (const call of message.tool_calls ?? []) {
      calls.push({
        id: call.id,
        name: call.function?.name ?? '',
        // Arguments arrive as a JSON string. A model can emit malformed JSON
        // here; treat that as a failed call rather than crashing the turn, and
        // let the registry hand back a validation error the model can correct.
        args: safeParseArgs(call.function?.arguments),
      });
    }

    return {
      conversationId,
      text: typeof message.content === 'string' ? message.content : '',
      calls,
    };
  }

  private async post(body: unknown): Promise<ChatMessage> {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      throw new ServiceUnavailableException(
        'The assistant is not configured: GROQ_API_KEY is missing from the server environment.',
      );
    }

    let lastDetail = 'Unknown provider error.';

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const response = await fetch(ENDPOINT, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if (response.ok) {
          const json = (await response.json()) as {
            choices?: Array<{ message?: ChatMessage }>;
          };
          const message = json.choices?.[0]?.message;
          if (!message) {
            throw new Error('Response contained no message.');
          }
          return message;
        }

        const detail = await response.text().catch(() => '');
        lastDetail = `HTTP ${response.status} ${detail.slice(0, 300)}`;

        if (response.status === 401 || response.status === 403) {
          this.logger.error(`Groq auth failure: ${lastDetail}`);
          throw new ServiceUnavailableException(
            'The assistant could not authenticate with Groq. The API key is missing or not valid.',
          );
        }

        // Only 5xx is worth another go. A 429 reports a tokens-per-minute
        // budget and names the wait -- "try again in 11.9s" -- so retrying a few
        // hundred milliseconds later burns attempts and fails identically, as
        // does retrying a 400, where the request itself is what is wrong.
        if (response.status < 500 || attempt === MAX_ATTEMPTS - 1) break;
      } catch (error) {
        if (error instanceof ServiceUnavailableException) throw error;
        lastDetail = error instanceof Error ? error.message : String(error);
        if (attempt === MAX_ATTEMPTS - 1) break;
      }

      this.logger.warn(
        `Groq call failed (attempt ${attempt + 1}/${MAX_ATTEMPTS}, retrying): ${lastDetail}`,
      );
      await delay(RETRY_DELAYS_MS[attempt] ?? 1200);
    }

    this.logger.error(`Groq call failed: ${lastDetail}`);
    const wait = /try again in ([0-9.]+)s/i.exec(lastDetail)?.[1];
    throw new ServiceUnavailableException(
      /429|rate limit|quota/i.test(lastDetail)
        ? 'The assistant hit its per-minute usage limit with Groq.' +
          (wait
            ? ' Try again in about ' + Math.ceil(Number(wait)) + ' seconds.'
            : ' Try again shortly.')
        : 'The assistant could not complete the request. Please try again.',
    );
  }

  private load(conversationId: string): ChatMessage[] {
    this.evictExpired();
    return this.conversations.get(conversationId)?.messages ?? [];
  }

  private save(conversationId: string, messages: ChatMessage[]): void {
    this.conversations.set(conversationId, {
      messages,
      touchedAt: Date.now(),
    });

    if (this.conversations.size > MAX_CONVERSATIONS) {
      // Evict least recently touched, so an active chat is never the casualty.
      const oldest = [...this.conversations.entries()].sort(
        (a, b) => a[1].touchedAt - b[1].touchedAt,
      )[0];
      if (oldest) this.conversations.delete(oldest[0]);
    }
  }

  private evictExpired(): void {
    const cutoff = Date.now() - CONVERSATION_TTL_MS;
    for (const [id, entry] of this.conversations) {
      if (entry.touchedAt < cutoff) this.conversations.delete(id);
    }
  }
}

function safeParseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
