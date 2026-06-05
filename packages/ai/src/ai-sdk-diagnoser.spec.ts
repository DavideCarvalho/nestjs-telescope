// packages/ai/src/ai-sdk-diagnoser.spec.ts
import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2Content,
} from '@ai-sdk/provider';
import type { DiagnoseContext } from '@dudousxd/nestjs-telescope';
import { describe, expect, it } from 'vitest';
import { createAiSdkDiagnoser } from './ai-sdk-diagnoser.js';
import { SYSTEM_PROMPT } from './prompt.js';

/**
 * Minimal typed `LanguageModelV2` stub. We avoid the AI SDK's `ai/test`
 * `MockLanguageModelV2` because it pulls in `msw` transitively; this stub
 * implements just the `doGenerate` surface `generateText` uses and records calls.
 */
class StubModel implements LanguageModelV2 {
  readonly specificationVersion = 'v2';
  readonly provider = 'stub';
  readonly modelId = 'stub-model';
  readonly supportedUrls: Record<string, RegExp[]> = {};
  readonly calls: LanguageModelV2CallOptions[] = [];

  constructor(
    private readonly handler:
      | { text: string }
      | { generate: (options: LanguageModelV2CallOptions) => Promise<string> },
  ) {}

  async doGenerate(options: LanguageModelV2CallOptions): ReturnType<LanguageModelV2['doGenerate']> {
    this.calls.push(options);
    const text = 'text' in this.handler ? this.handler.text : await this.handler.generate(options);
    const content: LanguageModelV2Content[] = [{ type: 'text', text }];
    return {
      content,
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      warnings: [],
    };
  }

  doStream(): ReturnType<LanguageModelV2['doStream']> {
    throw new Error('not implemented');
  }
}

function serverContext(overrides: Partial<DiagnoseContext> = {}): DiagnoseContext {
  return {
    exceptionClass: 'TypeError',
    message: "Cannot read properties of undefined (reading 'id')",
    stack: 'TypeError: x\n    at OrderService.create (orders.service.ts:42)\n    at Router.handle',
    request: { route: '/api/orders', method: 'POST', statusCode: 500, durationMs: 87 },
    url: null,
    userAgent: null,
    recentQueries: [
      'select * from orders where user_id = ?',
      'insert into orders (...) values (...)',
    ],
    client: false,
    occurrenceCount: 3,
    ...overrides,
  };
}

/** The user message text, regardless of whether content is a string or parts. */
function userText(call: LanguageModelV2CallOptions | undefined): string {
  const message = call?.prompt.find((part) => part.role === 'user');
  return JSON.stringify(message?.content ?? '');
}

describe('createAiSdkDiagnoser', () => {
  it('passes the system prompt and a context-derived user prompt to the model', async () => {
    const model = new StubModel({ text: '## Probable root cause\nA null deref.' });
    const diagnoser = createAiSdkDiagnoser({ model });

    const markdown = await diagnoser.diagnose(serverContext());

    expect(markdown).toBe('## Probable root cause\nA null deref.');
    expect(model.calls).toHaveLength(1);
    const systemMessage = model.calls[0]?.prompt.find((part) => part.role === 'system');
    expect(systemMessage?.content).toBe(SYSTEM_PROMPT);
    const text = userText(model.calls[0]);
    expect(text).toContain('TypeError');
    expect(text).toContain('POST /api/orders');
    expect(text).toContain('select * from orders where user_id = ?');
  });

  it('bounds output with the configured maxOutputTokens', async () => {
    const model = new StubModel({ text: 'ok' });
    const diagnoser = createAiSdkDiagnoser({ model, maxOutputTokens: 256 });
    await diagnoser.diagnose(serverContext());
    expect(model.calls[0]?.maxOutputTokens).toBe(256);
  });

  it('defaults maxOutputTokens to 1024', async () => {
    const model = new StubModel({ text: 'ok' });
    const diagnoser = createAiSdkDiagnoser({ model });
    await diagnoser.diagnose(serverContext());
    expect(model.calls[0]?.maxOutputTokens).toBe(1024);
  });

  it('renders a client (browser) exception without route/queries', async () => {
    const model = new StubModel({ text: 'ok' });
    const diagnoser = createAiSdkDiagnoser({ model });
    await diagnoser.diagnose(
      serverContext({
        client: true,
        request: null,
        url: 'https://app.example.com/checkout',
        userAgent: 'Mozilla/5.0',
        recentQueries: [],
      }),
    );
    const text = userText(model.calls[0]);
    expect(text).toContain('browser (client-side)');
    expect(text).toContain('https://app.example.com/checkout');
  });

  it('rejects when the model errors', async () => {
    const model = new StubModel({
      generate: async () => {
        throw new Error('model unavailable');
      },
    });
    const diagnoser = createAiSdkDiagnoser({ model });
    await expect(diagnoser.diagnose(serverContext())).rejects.toThrow();
  });

  it('rejects when the model exceeds the timeout (aborts)', async () => {
    const model = new StubModel({
      generate: (options) =>
        new Promise((_resolve, reject) => {
          options.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    const diagnoser = createAiSdkDiagnoser({ model, timeoutMs: 5 });
    await expect(diagnoser.diagnose(serverContext())).rejects.toThrow();
  });
});
