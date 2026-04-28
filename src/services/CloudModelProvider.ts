import { ModelConfig } from './ModelConfigService.js';
import { ChatMessage, FallbackResult } from './OllamaService.js';

export interface CloudChatOptions {
  model: ModelConfig;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
}

class CloudModelProvider {
  /**
   * Send a chat completion request to an OpenAI-compatible cloud API.
   */
  async chat(opts: CloudChatOptions): Promise<FallbackResult> {
    const { model, messages, maxTokens, temperature } = opts;

    const url = `${model.baseUrl}/chat/completions`;
    const body: Record<string, any> = {
      model: model.modelId,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      max_tokens: maxTokens || model.maxTokens || 2048,
      temperature: temperature ?? 0.7,
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${model.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(model.timeoutMs || 30000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Cloud API ${res.status}: ${errText.slice(0, 300)}`);
    }

    const data = await res.json() as any;
    const content = data.choices?.[0]?.message?.content || '';
    return {
      content,
      model: model.modelId,
      fallbackUsed: false,
      originalModel: model.modelId,
    };
  }

  /**
   * Stream a chat completion from an OpenAI-compatible cloud API.
   * Yields content chunks as strings.
   */
  async *chatStream(opts: CloudChatOptions): AsyncGenerator<string> {
    const { model, messages, maxTokens, temperature } = opts;

    const url = `${model.baseUrl}/chat/completions`;
    const body: Record<string, any> = {
      model: model.modelId,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      max_tokens: maxTokens || model.maxTokens || 2048,
      temperature: temperature ?? 0.7,
      stream: true,
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${model.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(model.timeoutMs || 60000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Cloud API ${res.status}: ${errText.slice(0, 300)}`);
    }

    if (!res.body) throw new Error('No response body for streaming');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (!trimmed.startsWith('data: ')) continue;

        try {
          const json = JSON.parse(trimmed.slice(6));
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch {
          // skip malformed chunks
        }
      }
    }
  }

  /**
   * Generate an embedding using an OpenAI-compatible cloud API.
   */
  async embed(model: ModelConfig, text: string): Promise<number[]> {
    const url = `${model.baseUrl}/embeddings`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${model.apiKey}`,
      },
      body: JSON.stringify({
        model: model.modelId,
        input: text,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Cloud Embed API ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = await res.json() as any;
    return data.data?.[0]?.embedding || [];
  }
}

export const cloudModelProvider = new CloudModelProvider();
