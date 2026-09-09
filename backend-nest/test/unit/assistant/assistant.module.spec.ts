import { selectProvider } from '../../../src/assistant/assistant.module';
import { AnthropicClient } from '../../../src/assistant/llm/anthropic.client';
import { GeminiClient } from '../../../src/assistant/llm/gemini.client';
import { GroqClient } from '../../../src/assistant/llm/groq.client';

/**
 * Provider selection is the one piece of wiring a misconfiguration turns into a
 * confusing runtime failure rather than a clear one, so it is pinned here.
 */
describe('selectProvider', () => {
  const KEYS = [
    'ASSISTANT_PROVIDER',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'GROQ_API_KEY',
  ];

  let saved: Record<string, string | undefined>;
  let anthropic: AnthropicClient;
  let gemini: GeminiClient;
  let groq: GroqClient;

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    KEYS.forEach((k) => delete process.env[k]);
    anthropic = new AnthropicClient();
    gemini = new GeminiClient();
    groq = new GroqClient();
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('honours an explicit ASSISTANT_PROVIDER over any key present', () => {
    process.env.ASSISTANT_PROVIDER = 'gemini';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';

    expect(selectProvider(anthropic, gemini, groq).providerName).toBe('gemini');
  });

  it('accepts "claude" as an alias for anthropic', () => {
    process.env.ASSISTANT_PROVIDER = 'claude';
    expect(selectProvider(anthropic, gemini, groq).providerName).toBe('anthropic');
  });

  it('auto-detects whichever provider has a credential', () => {
    process.env.GEMINI_API_KEY = 'AIza-test';
    expect(selectProvider(anthropic, gemini, groq).providerName).toBe('gemini');
  });

  it('prefers Claude when both are configured', () => {
    process.env.GEMINI_API_KEY = 'AIza-test';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';

    expect(selectProvider(anthropic, gemini, groq).providerName).toBe('anthropic');
  });

  it('falls back to auto-detection on an unknown provider name', () => {
    process.env.ASSISTANT_PROVIDER = 'llama';
    process.env.GEMINI_API_KEY = 'AIza-test';

    expect(selectProvider(anthropic, gemini, groq).providerName).toBe('gemini');
  });

  it('selects Groq when asked for it', () => {
    process.env.ASSISTANT_PROVIDER = 'groq';
    expect(selectProvider(anthropic, gemini, groq).providerName).toBe('groq');
  });

  it('prefers Groq over Gemini when auto-detecting', () => {
    // Groq answers a tool-selection turn in well under a second; the Gemini
    // free tier can take tens of seconds, so it is the weaker default.
    process.env.GROQ_API_KEY = 'gsk-test';
    process.env.GEMINI_API_KEY = 'AIza-test';

    expect(selectProvider(anthropic, gemini, groq).providerName).toBe('groq');
  });

  it('still returns a bootable provider when nothing is configured', () => {
    const provider = selectProvider(anthropic, gemini, groq);

    // The module must load either way; the UI hides itself off isConfigured().
    expect(provider).toBeDefined();
    expect(provider.isConfigured()).toBe(false);
  });
});

describe('AnthropicClient.isConfigured', () => {
  it('accepts either an API key or an auth token', () => {
    const client = new AnthropicClient();
    const savedKey = process.env.ANTHROPIC_API_KEY;
    const savedToken = process.env.ANTHROPIC_AUTH_TOKEN;

    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    expect(client.isConfigured()).toBe(false);

    process.env.ANTHROPIC_AUTH_TOKEN = 'oauth-token';
    expect(client.isConfigured()).toBe(true);

    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
    if (savedToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = savedToken;
  });
});
