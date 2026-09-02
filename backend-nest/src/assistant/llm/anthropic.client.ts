import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'crypto';
import {
  LlmProvider,
  ModelFunctionCall,
  ModelTurn,
  StartParams,
  SubmitToolResultsParams,
  ToolDeclaration,
} from './llm.provider';

const DEFAULT_MODEL = 'claude-opus-5';
const MAX_TOKENS = 8_000;

/** How long an idle conversation is kept before it is dropped. */
const CONVERSATION_TTL_MS = 60 * 60 * 1000;
/** Ceiling on stored conversations, so a busy day cannot grow without bound. */
const MAX_CONVERSATIONS = 500;

interface StoredConversation {
  messages: Anthropic.MessageParam[];
  touchedAt: number;
}

/**
 * Claude-backed implementation of the assistant's model provider.
 *
 * The Messages API is stateless -- the whole history goes up on every request --
 * so continuity lives here: `conversationId` keys a message list we own.
 *
 * The store is in-memory on purpose. Redis is disabled in this deployment, and
 * a lost conversation costs the user only the thread of a chat, not data. It
 * does mean history is per-process: behind more than one instance, follow-up
 * questions need sticky sessions or a shared store.
 */
@Injectable()
export class AnthropicClient implements LlmProvider {
  readonly providerName = 'anthropic';

  private readonly logger = new Logger(AnthropicClient.name);
  private client: Anthropic | null = null;
  private readonly conversations = new Map<string, StoredConversation>();

  private get model(): string {
    return process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
  }

  isConfigured(): boolean {
    return Boolean(
      process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN,
    );
  }

  private get sdk(): Anthropic {
    if (this.client) return this.client;
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException(
        'The assistant is not configured: ANTHROPIC_API_KEY is missing from the server environment.',
      );
    }
    // Zero-arg construction: the SDK resolves ANTHROPIC_API_KEY, then
    // ANTHROPIC_AUTH_TOKEN, then an `ant auth login` profile.
    this.client = new Anthropic();
    return this.client;
  }

  async start(params: StartParams): Promise<ModelTurn> {
    const conversationId = params.conversationId ?? randomUUID();
    const stored = this.load(conversationId);

    stored.push({ role: 'user', content: params.userMessage });

    return this.send(
      conversationId,
      stored,
      params.systemInstruction,
      params.tools,
    );
  }

  async submitToolResults(
    params: SubmitToolResultsParams,
  ): Promise<ModelTurn> {
    const stored = this.load(params.conversationId);

    // Every result for a turn goes back in ONE user message. Splitting them
    // across several messages teaches the model to stop calling tools in
    // parallel, which makes later answers slower for no benefit.
    stored.push({
      role: 'user',
      content: params.results.map((r) => ({
        type: 'tool_result' as const,
        tool_use_id: r.callId,
        is_error: r.isError,
        content:
          typeof r.result === 'string' ? r.result : JSON.stringify(r.result),
      })),
    });

    return this.send(
      params.conversationId,
      stored,
      params.systemInstruction,
      params.tools,
    );
  }

  private async send(
    conversationId: string,
    messages: Anthropic.MessageParam[],
    system: string,
    tools: ToolDeclaration[],
  ): Promise<ModelTurn> {
    let response: Anthropic.Message;

    try {
      // Streaming rather than create(): the tool-calling turns can be long, and
      // a non-streaming request at this max_tokens risks an HTTP timeout.
      const stream = this.sdk.messages.stream({
        model: this.model,
        max_tokens: MAX_TOKENS,
        // The system prompt and tool list are identical on every request, so
        // caching the prefix makes each follow-up turn markedly cheaper.
        system: [
          {
            type: 'text',
            text: system,
            cache_control: { type: 'ephemeral' },
          },
        ],
        tools: tools.map((t) => this.toAnthropicTool(t)),
        messages,
      });

      response = await stream.finalMessage();
    } catch (error) {
      throw this.translate(error);
    }

    // Preserve the assistant turn verbatim -- the tool_use blocks in it are
    // what the next tool_result blocks refer to by id.
    messages.push({ role: 'assistant', content: response.content });
    this.save(conversationId, messages);

    const calls: ModelFunctionCall[] = [];
    let text = '';

    for (const block of response.content) {
      if (block.type === 'text') {
        text += block.text;
      } else if (block.type === 'tool_use') {
        calls.push({
          id: block.id,
          name: block.name,
          // Tool inputs are parsed JSON already; never string-match them.
          args: (block.input as Record<string, unknown>) ?? {},
        });
      }
    }

    if (response.stop_reason === 'refusal') {
      text =
        text ||
        'لم أستطع تنفيذ هذا الطلب. حاول صياغته بشكل مختلف أو اسأل عن شيء آخر.';
    }

    return { conversationId, text, calls };
  }

  private toAnthropicTool(tool: ToolDeclaration): Anthropic.Tool {
    return {
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters as Anthropic.Tool.InputSchema,
    };
  }

  /**
   * Map SDK errors onto something safe to show a user.
   *
   * Provider errors can carry request metadata, and on an auth failure the raw
   * text is not actionable anyway.
   */
  private translate(error: unknown): Error {
    if (error instanceof Anthropic.AuthenticationError) {
      this.logger.error('Anthropic authentication failed.');
      return new ServiceUnavailableException(
        'The assistant could not authenticate with Claude. The API key is missing or not valid.',
      );
    }
    if (error instanceof Anthropic.RateLimitError) {
      return new ServiceUnavailableException(
        'The assistant is rate limited right now. Try again in a moment.',
      );
    }
    if (error instanceof Anthropic.APIError) {
      this.logger.error(`Anthropic API error ${error.status}: ${error.message}`);
      return new ServiceUnavailableException(
        'The assistant is temporarily unavailable. Please try again.',
      );
    }

    this.logger.error(
      `Anthropic call failed: ${
        error instanceof Error ? error.message : 'unknown'
      }`,
    );
    return new ServiceUnavailableException(
      'The assistant is temporarily unavailable. Please try again.',
    );
  }

  private load(conversationId: string): Anthropic.MessageParam[] {
    this.evictExpired();
    return this.conversations.get(conversationId)?.messages ?? [];
  }

  private save(
    conversationId: string,
    messages: Anthropic.MessageParam[],
  ): void {
    this.conversations.set(conversationId, {
      messages,
      touchedAt: Date.now(),
    });

    if (this.conversations.size > MAX_CONVERSATIONS) {
      // Drop the least recently touched rather than an arbitrary one, so an
      // active chat is never the thing that gets evicted.
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
