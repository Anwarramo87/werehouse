import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { GoogleGenAI } from '@google/genai';
import {
  LlmProvider,
  ModelFunctionCall,
  ModelTurn,
  StartParams,
  SubmitToolResultsParams,
  ToolDeclaration,
} from './llm.provider';

const DEFAULT_MODEL = 'gemini-2.5-flash';

/** Total attempts per model call, including the first. */
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [400, 1200];

const AUTH_FAILURE = /api[_ ]?key|unauthenticated|permission|denied|401|403/i;
const QUOTA = /quota|rate limit|429/i;
/**
 * Worth another go: a malformed tool-call JSON blob, or a server-side blip.
 *
 * Quota errors are deliberately NOT here. Google answers a 429 with a concrete
 * "retry in 34s"; retrying after a second consumes another request from the
 * same exhausted budget and fails again. Surface it instead.
 */
const RETRYABLE =
  /invalid JSON|could not be parsed|50\d|unavailable|overloaded|timeout|ECONNRESET|unusable|socket|fetch failed/i;

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Gemini-backed implementation of the assistant's model provider.
 *
 * Unlike Claude, Gemini stores the transcript itself, so continuity is just the
 * interaction id it hands back -- no local message history.
 */
@Injectable()
export class GeminiClient implements LlmProvider {
  readonly providerName = 'gemini';

  private readonly logger = new Logger(GeminiClient.name);
  private client: GoogleGenAI | null = null;

  private get model(): string {
    return process.env.GEMINI_MODEL || DEFAULT_MODEL;
  }

  isConfigured(): boolean {
    return Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
  }

  private get sdk(): GoogleGenAI {
    if (this.client) return this.client;

    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new ServiceUnavailableException(
        'The assistant is not configured: GEMINI_API_KEY is missing from the server environment.',
      );
    }

    this.client = new GoogleGenAI({ apiKey });
    return this.client;
  }

  async start(params: StartParams): Promise<ModelTurn> {
    return this.call({
      tools: params.tools.map((t) => this.toGeminiTool(t)),
      system_instruction: params.systemInstruction,
      input: params.userMessage,
      ...(params.conversationId
        ? { previous_interaction_id: params.conversationId }
        : {}),
    });
  }

  async submitToolResults(params: SubmitToolResultsParams): Promise<ModelTurn> {
    return this.call({
      tools: params.tools.map((t) => this.toGeminiTool(t)),
      previous_interaction_id: params.conversationId,
      input: params.results.map((r) => ({
        type: 'function_result' as const,
        call_id: r.callId,
        name: r.name,
        is_error: r.isError,
        // The field accepts a string; stringifying keeps nested shapes intact
        // instead of flattening them.
        result: JSON.stringify(r.result),
      })),
    });
  }

  /**
   * Gemini's function declarations are an OpenAPI 3.0 subset, and its parser
   * rejects `additionalProperties`. Claude accepts it, so it is stripped here
   * rather than in the registry.
   */
  private toGeminiTool(tool: ToolDeclaration) {
    return {
      type: 'function' as const,
      name: tool.name,
      description: tool.description,
      parameters: stripAdditionalProperties(tool.parameters),
    };
  }

  /**
   * Issue the request, retrying the failures that are worth retrying.
   *
   * The flash models intermittently emit malformed JSON for a tool call and the
   * API rejects the whole turn with a 400. Google's own error text says to
   * retry, and a retry does succeed -- it is a sampling accident, not a bad
   * request. Transient 429s and 5xx get the same treatment.
   */
  private async createWithRetry(body: Record<string, unknown>) {
    let lastMessage = 'Unknown provider error.';

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        return await this.sdk.interactions.create({
          model: this.model,
          store: true,
          ...body,
        } as Parameters<typeof this.sdk.interactions.create>[0]);
      } catch (error) {
        lastMessage =
          error instanceof Error ? error.message : 'Unknown provider error.';

        if (AUTH_FAILURE.test(lastMessage)) {
          this.logger.error(`Gemini auth failure: ${lastMessage}`);
          // Never surface the raw provider error -- it can carry request
          // metadata, and on an auth failure it is not actionable anyway.
          throw new ServiceUnavailableException(
            'The assistant could not authenticate with Gemini. The API key is missing, expired, or the project is not allowed to use this model.',
          );
        }

        const retryable = RETRYABLE.test(lastMessage);
        const lastAttempt = attempt === MAX_ATTEMPTS - 1;

        this.logger.warn(
          `Gemini call failed (attempt ${attempt + 1}/${MAX_ATTEMPTS}${
            retryable && !lastAttempt ? ', retrying' : ''
          }): ${lastMessage}`,
        );

        if (!retryable || lastAttempt) break;
        await delay(RETRY_DELAYS_MS[attempt] ?? 1500);
      }
    }

    this.logger.error(`Gemini call failed: ${lastMessage}`);
    throw new ServiceUnavailableException(
      QUOTA.test(lastMessage)
        ? 'The assistant has hit its usage limit with Gemini for now. Try again shortly, or raise the quota on the API key.'
        : 'The assistant could not complete the request. Please try again.',
    );
  }

  private async call(body: Record<string, unknown>): Promise<ModelTurn> {
    const interaction = await this.createWithRetry(body);

    const steps = (interaction as { steps?: unknown[] }).steps ?? [];
    const calls: ModelFunctionCall[] = [];
    let text = '';

    for (const step of steps as Array<Record<string, unknown>>) {
      if (step.type === 'function_call') {
        calls.push({
          id: String(step.id ?? ''),
          name: String(step.name ?? ''),
          args: (step.arguments as Record<string, unknown>) ?? {},
        });
        continue;
      }

      if (step.type === 'model_output') {
        const content = (step.content as Array<Record<string, unknown>>) ?? [];
        for (const part of content) {
          if (part.type === 'text' && typeof part.text === 'string') {
            text += part.text;
          }
        }
      }
    }

    return {
      conversationId: String((interaction as { id?: string }).id ?? ''),
      text,
      calls,
    };
  }
}

function stripAdditionalProperties(node: unknown): Record<string, unknown> {
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== 'object') return value;

    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'additionalProperties') continue;
      out[key] = walk(inner);
    }
    return out;
  };

  return walk(node) as Record<string, unknown>;
}
