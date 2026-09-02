import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { z } from 'zod';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Permissions } from '../common/decorators/permissions.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { AuthenticatedUser } from '../common/types/authenticated-user.types';
import { AssistantService } from './assistant.service';

const askSchema = z.object({
  message: z.string().min(1).max(2000),
  /**
   * Ties this question to the previous exchange. The transcript is held
   * server-side and this is only a handle to it, so the client cannot rewrite
   * what was said earlier.
   */
  conversationId: z.string().max(200).optional(),
});

/**
 * Any one of these lets a user open the assistant. The tool registry then
 * narrows what it can actually reach to the permissions they really hold, so a
 * warehouse user gets inventory tools and no payroll tools.
 */
const ASSISTANT_PERMISSIONS = [
  'view_employees',
  'view_attendance',
  'view_payroll',
  'view_inventory',
  'view_sales',
  'view_purchasing',
] as const;

@ApiTags('assistant')
@Controller('assistant')
// Auth is per-controller in this codebase -- only ThrottlerGuard is global --
// so both guards must be named here. Without them `request.user` is undefined
// and the per-user tool filtering has nothing to filter on.
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AssistantController {
  constructor(private readonly assistant: AssistantService) {}

  @Get('status')
  @Permissions(...ASSISTANT_PERMISSIONS)
  @ApiOperation({ summary: 'Whether the assistant is configured and usable' })
  status() {
    return {
      configured: this.assistant.isConfigured(),
      provider: this.assistant.providerName(),
    };
  }

  @Post('chat')
  @Permissions(...ASSISTANT_PERMISSIONS)
  @ApiOperation({ summary: 'Ask the assistant a question (SSE stream)' })
  async chat(
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
    @Res() res: Response,
  ): Promise<void> {
    const parsed = askSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        parsed.error.issues.map((i) => i.message).join(', '),
      );
    }

    // The super admin has no factory of its own, and every assistant tool reads
    // factory-scoped data. Refusing here is clearer than returning nothing.
    if (!user.tenantId) {
      throw new ForbiddenException(
        'The assistant runs inside one factory. Sign in as a factory user to use it.',
      );
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Stops nginx buffering the stream into one lump on the way to the browser.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    let aborted = false;
    res.on('close', () => {
      aborted = true;
    });

    try {
      for await (const event of this.assistant.ask({
        user,
        tenantId: user.tenantId,
        message: parsed.data.message,
        conversationId: parsed.data.conversationId,
      })) {
        if (aborted) break;
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch {
      if (!aborted) {
        res.write(
          `data: ${JSON.stringify({
            type: 'error',
            message: 'The assistant stopped unexpectedly.',
          })}\n\n`,
        );
      }
    } finally {
      if (!aborted) res.end();
    }
  }
}
