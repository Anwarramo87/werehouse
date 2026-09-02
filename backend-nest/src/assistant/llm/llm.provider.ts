/**
 * The contract every model provider satisfies.
 *
 * The assistant service deals only in these types, so switching providers is a
 * matter of binding a different implementation -- no tool, controller, or
 * frontend code changes.
 */

/** A tool as the registry describes it, before any provider-specific shaping. */
export interface ToolDeclaration {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
}

/** One tool call the model wants us to run. */
export interface ModelFunctionCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** What one turn of the model produced. */
export interface ModelTurn {
  /**
   * Opaque handle for continuing this conversation on the next question.
   *
   * Providers differ in what continuity means -- a server-stored interaction id
   * for Gemini, a key into our own message history for Claude -- so callers
   * must treat it as a token to hand back, never parse it.
   */
  conversationId: string;
  text: string;
  calls: ModelFunctionCall[];
}

/** A result being handed back for a call the model made. */
export interface ToolResultInput {
  callId: string;
  name: string;
  result: unknown;
  isError: boolean;
}

export interface StartParams {
  systemInstruction: string;
  tools: ToolDeclaration[];
  userMessage: string;
  conversationId?: string;
}

export interface SubmitToolResultsParams {
  systemInstruction: string;
  tools: ToolDeclaration[];
  conversationId: string;
  results: ToolResultInput[];
}

export interface LlmProvider {
  /** Shown in logs and diagnostics, e.g. "anthropic". */
  readonly providerName: string;

  /** Whether a usable credential is present, so the UI can hide itself early. */
  isConfigured(): boolean;

  start(params: StartParams): Promise<ModelTurn>;

  submitToolResults(params: SubmitToolResultsParams): Promise<ModelTurn>;
}

/** Injection token -- the concrete provider is chosen in the module. */
export const LLM_PROVIDER = Symbol('LLM_PROVIDER');
