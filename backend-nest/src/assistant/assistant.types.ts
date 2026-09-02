import { z } from 'zod';
import { AuthenticatedUser } from '../common/types/authenticated-user.types';

/**
 * Everything a tool is allowed to know about who is asking.
 *
 * There is deliberately no Prisma client on here -- tools receive their
 * dependencies through the Nest injector, so a tool cannot reach around the
 * tenant-scoped client it was given.
 */
export interface AssistantContext {
  user: AuthenticatedUser;
  tenantId: string;
}

/**
 * One capability the model may invoke.
 *
 * `description` is not documentation -- it is the prompt. It is the only thing
 * the model reads when deciding whether this tool answers the question, so it
 * should say what the tool returns and, where the wording is ambiguous in
 * Arabic or English, which interpretation it takes.
 */
export interface AssistantTool<TIn extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  input: TIn;
  /** Permission strings, matching those enforced by PermissionsGuard. */
  permissions: string[];
  run(input: z.infer<TIn>, ctx: AssistantContext): Promise<unknown>;
}

/** Events pushed to the browser over SSE. */
export type AssistantEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_start'; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; name: string; rowCount: number; ms: number }
  | { type: 'tool_error'; name: string; message: string }
  | { type: 'navigate'; route: string; params?: Record<string, string>; reason: string }
  | { type: 'done'; conversationId?: string }
  | { type: 'error'; message: string };

/**
 * Rows returned to the model.
 *
 * Every row is re-sent to the provider and counts against its token budget, so
 * the default is deliberately small: tools report the true match count
 * separately, and the model is told to answer "how many" from that rather than
 * by counting rows. A caller can still ask for more, up to MAX_ROW_LIMIT.
 */
export const DEFAULT_ROW_LIMIT = 15;
export const MAX_ROW_LIMIT = 200;
