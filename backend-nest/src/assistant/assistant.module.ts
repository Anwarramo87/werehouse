import { Logger, Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AssistantController } from './assistant.controller';
import { AssistantService } from './assistant.service';
import { AnthropicClient } from './llm/anthropic.client';
import { GeminiClient } from './llm/gemini.client';
import { GroqClient } from './llm/groq.client';
import { LLM_PROVIDER, LlmProvider } from './llm/llm.provider';
import { HrTools } from './tools/hr.tools';
import { InventoryTools } from './tools/inventory.tools';
import { NavigationTools } from './tools/navigation.tools';
import { SalesTools } from './tools/sales.tools';
import { ToolRegistry } from './tools/registry';

/**
 * Pick the model provider.
 *
 * ASSISTANT_PROVIDER wins when set, so switching is a one-line env change.
 * Otherwise whichever provider actually has a credential is used, preferring
 * Claude -- that way adding a key is enough to turn the assistant on, with no
 * second setting to remember.
 */
export function selectProvider(
  anthropic: AnthropicClient,
  gemini: GeminiClient,
  groq: GroqClient,
): LlmProvider {
  const logger = new Logger('AssistantProvider');
  const requested = (process.env.ASSISTANT_PROVIDER || '').trim().toLowerCase();

  if (requested === 'anthropic' || requested === 'claude') return anthropic;
  if (requested === 'gemini' || requested === 'google') return gemini;
  if (requested === 'groq') return groq;

  if (requested) {
    logger.warn(
      `Unknown ASSISTANT_PROVIDER "${requested}" — falling back to auto-detection.`,
    );
  }

  if (anthropic.isConfigured()) return anthropic;
  if (groq.isConfigured()) return groq;
  if (gemini.isConfigured()) return gemini;

  // Neither is configured. Returning one anyway keeps the module bootable --
  // isConfigured() is false, so the UI hides itself and /chat fails clearly.
  logger.warn(
    'No assistant credentials found (ANTHROPIC_API_KEY, GROQ_API_KEY or GEMINI_API_KEY). The assistant will report itself as unconfigured.',
  );
  return anthropic;
}

@Module({
  imports: [PrismaModule],
  controllers: [AssistantController],
  providers: [
    AssistantService,
    ToolRegistry,
    HrTools,
    InventoryTools,
    SalesTools,
    NavigationTools,
    AnthropicClient,
    GeminiClient,
    GroqClient,
    {
      provide: LLM_PROVIDER,
      inject: [AnthropicClient, GeminiClient, GroqClient],
      useFactory: selectProvider,
    },
  ],
})
export class AssistantModule {}
