import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../prisma/prisma.service';
import { runWithTenant } from '../../common/tenant/tenant-context';
import { SUPERADMIN_ROLE } from '../../common/tenant/tenant.constants';
import { AssistantContext, AssistantTool } from '../assistant.types';
import { ToolDeclaration } from '../llm/llm.provider';
import { HrTools } from './hr.tools';
import { InventoryTools } from './inventory.tools';
import { SalesTools } from './sales.tools';
import { NavigationTools } from './navigation.tools';

export interface ToolOutcome {
  ok: boolean;
  result: unknown;
  rowCount: number;
  ms: number;
}

/**
 * Drops `$schema`, which zod emits and no provider wants.
 *
 * Provider-specific narrowing (Gemini rejects `additionalProperties`, Claude
 * accepts it) belongs in the client, not here.
 */
function sanitiseSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitiseSchema);
  if (!node || typeof node !== 'object') return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === '$schema') continue;
    out[key] = sanitiseSchema(value);
  }
  return out;
}

@Injectable()
export class ToolRegistry {
  private readonly logger = new Logger(ToolRegistry.name);
  private readonly tools = new Map<string, AssistantTool>();

  constructor(
    private readonly prisma: PrismaService,
    hr: HrTools,
    inventory: InventoryTools,
    sales: SalesTools,
    navigation: NavigationTools,
  ) {
    for (const tool of [
      ...hr.tools(),
      ...inventory.tools(),
      ...sales.tools(),
      ...navigation.tools(),
    ]) {
      this.tools.set(tool.name, tool);
    }
  }

  /**
   * The declarations handed to the model, filtered to what this user may do.
   *
   * Filtering here rather than at call time means the model is never tempted by
   * a tool it would only be refused for -- it does not know payroll exists for
   * a user who cannot see payroll.
   */
  declarationsFor(user: AuthenticatedLike): ToolDeclaration[] {
    return [...this.tools.values()]
      .filter((tool) => this.mayUse(tool, user))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: sanitiseSchema(
          z.toJSONSchema(tool.input, { target: 'draft-7' }),
        ) as Record<string, unknown>,
      }));
  }

  private mayUse(tool: AssistantTool, user: AuthenticatedLike): boolean {
    if (tool.permissions.length === 0) return true;
    if ((user.roles ?? []).includes(SUPERADMIN_ROLE)) return true;
    const held = new Set(user.permissions ?? []);
    return tool.permissions.every((p) => held.has(p));
  }

  /**
   * Validate, authorise, execute, and record one tool call.
   *
   * Nothing the model produced reaches Prisma un-parsed: `tool.input.parse`
   * rejects a hallucinated field or an out-of-range limit before the query is
   * built, and the whole call runs inside `runWithTenant` so the Prisma
   * extension narrows every read to this factory.
   */
  async execute(
    name: string,
    rawArgs: unknown,
    ctx: AssistantContext,
  ): Promise<ToolOutcome> {
    const started = Date.now();
    const tool = this.tools.get(name);

    if (!tool) {
      return {
        ok: false,
        result: { error: `Unknown tool "${name}".` },
        rowCount: 0,
        ms: 0,
      };
    }

    if (!this.mayUse(tool, ctx.user)) {
      return {
        ok: false,
        result: {
          error:
            'You do not have permission to read this. Tell the user their account lacks access, and do not guess the answer.',
        },
        rowCount: 0,
        ms: Date.now() - started,
      };
    }

    const parsed = tool.input.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      return {
        ok: false,
        result: {
          error: 'Invalid arguments.',
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        },
        rowCount: 0,
        ms: Date.now() - started,
      };
    }

    try {
      // The async wrapper matters: a bare `runWithTenant(s, () => prisma.x.find())`
      // builds a lazy PrismaPromise inside the scope but resolves it outside,
      // losing the AsyncLocalStorage context and failing closed.
      const result = await runWithTenant(
        { tenantId: ctx.tenantId, bypass: false },
        async () => await tool.run(parsed.data, ctx),
      );

      const rowCount = Array.isArray(result)
        ? result.length
        : Array.isArray((result as { rows?: unknown[] })?.rows)
          ? (result as { rows: unknown[] }).rows.length
          : 1;

      await this.audit(name, parsed.data, ctx, rowCount);
      return { ok: true, result, rowCount, ms: Date.now() - started };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Tool execution failed.';
      this.logger.error(`assistant tool "${name}" failed: ${message}`);
      return {
        ok: false,
        result: { error: message },
        rowCount: 0,
        ms: Date.now() - started,
      };
    }
  }

  /**
   * A record of what the assistant read on whose behalf.
   *
   * Never allowed to break the answer -- an audit write that fails is logged
   * and swallowed.
   */
  private async audit(
    name: string,
    args: unknown,
    ctx: AssistantContext,
    rowCount: number,
  ): Promise<void> {
    try {
      await runWithTenant({ tenantId: ctx.tenantId, bypass: false }, async () =>
        this.prisma.auditLog.create({
          data: {
            actorId: ctx.user.userId,
            actorUsername: ctx.user.username,
            action: `assistant.${name}`,
            targetType: 'assistant',
            metadata: { args, rowCount } as object,
          },
        }),
      );
    } catch (error) {
      this.logger.warn(
        `assistant audit write failed for "${name}": ${
          error instanceof Error ? error.message : 'unknown'
        }`,
      );
    }
  }
}

type AuthenticatedLike = { roles?: string[]; permissions?: string[] };
