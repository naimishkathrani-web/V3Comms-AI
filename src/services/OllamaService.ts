import { Ollama } from 'ollama';
import { config, ModelFallbackEntry } from '../config/index.js';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ServiceResponse {
  content: string;
  model: string;
  fallbackUsed?: boolean;
  originalModel?: string;
}

export interface FallbackResult {
  content: string;
  model: string;
  fallbackUsed: boolean;
  originalModel: string;
}

export class OllamaService {
  private client: Ollama;
  private defaultModel: string;
  private activeRequests: number = 0;
  private maxConcurrent: number;
  private requestQueue: Array<() => void> = [];
  private availableModels: Set<string> = new Set();
  private fallbackChain: ModelFallbackEntry[];

  constructor(host?: string, defaultModel?: string) {
    const ollamaHost = host || config.ollama.host;
    this.defaultModel = defaultModel || config.ollama.model;
    this.maxConcurrent = config.maxConcurrentRequests;
    this.fallbackChain = config.ollama.fallbackChain;
    
    this.client = new Ollama({ host: ollamaHost });
    console.log(`[OllamaService] Initialized with host: ${ollamaHost}, model: ${this.defaultModel}, maxConcurrent: ${this.maxConcurrent}`);
    console.log(`[OllamaService] Fallback chain: ${this.fallbackChain.map(e => `${e.model}(${e.timeoutMs}ms)`).join(' → ')}`);
  }

  private async acquireSlot(): Promise<void> {
    if (this.activeRequests < this.maxConcurrent) {
      this.activeRequests++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.requestQueue.push(() => {
        this.activeRequests++;
        resolve();
      });
    });
  }

  private releaseSlot(): void {
    this.activeRequests--;
    const next = this.requestQueue.shift();
    if (next) next();
  }

  private buildOptions() {
    return {
      num_ctx: config.ollama.numCtx,
      num_predict: config.ollama.numPredict,
      num_batch: config.ollama.numBatch,
      num_thread: config.ollama.numThread || undefined,
      num_gpu: config.ollama.numGpu,
      flash_attention: config.ollama.flashAttention || undefined,
      temperature: config.ollama.temperature,
      top_k: config.ollama.topK,
      top_p: config.ollama.topP,
    };
  }

  public async checkConnection(): Promise<boolean> {
    try {
      const models = await this.client.list();
      this.availableModels = new Set(models.models?.map((m: any) => m.name) || []);
      console.log(`[OllamaService] Available models: ${Array.from(this.availableModels).join(', ')}`);
      return true;
    } catch (error) {
      console.warn('[OllamaService] Connection check failed:', error);
      return false;
    }
  }

  private getAvailableFallbackChain(): ModelFallbackEntry[] {
    if (this.availableModels.size === 0) {
      return this.fallbackChain;
    }
    return this.fallbackChain.filter(e => this.availableModels.has(e.model));
  }

  /**
   * Chat with automatic model fallback via streaming.
   * Tries models in priority order. If first token doesn't arrive within
   * timeoutMs, aborts that model and falls back to the next one.
   * Uses manual AsyncIterator control to race first token against timeout.
   */
  public async *chatStreamWithFallback(messages: ChatMessage[], options: { model?: string } = {}): AsyncGenerator<string> {
    await this.acquireSlot();
    try {
      const fullChain = this.getAvailableFallbackChain();

      // If a specific model is requested, find it in the fallback chain
      // and use the chain from that point onward (smarter start, still falls back)
      let chain = fullChain;
      if (options.model) {
        const startIdx = fullChain.findIndex(e => e.model === options.model);
        if (startIdx >= 0) {
          chain = fullChain.slice(startIdx);
        } else {
          // Model not in chain — use it directly with no fallback
          const response = await this.client.chat({
            model: options.model,
            messages,
            stream: true,
            keep_alive: config.ollama.keepAlive,
            options: this.buildOptions(),
          });
          for await (const part of response) {
            if (part.message?.content) yield part.message.content;
          }
          return;
        }
      }
      let lastError: Error | null = null;
      const originalModel = chain[0]?.model || this.defaultModel;
      let fallbackUsed = false;

      for (let i = 0; i < chain.length; i++) {
        const { model, timeoutMs } = chain[i];
        console.log(`[OllamaService] Trying model: ${model} (timeout: ${timeoutMs}ms)`);

        try {
          const stream = await this.client.chat({
            model,
            messages,
            stream: true,
            keep_alive: config.ollama.keepAlive,
            options: this.buildOptions(),
          });

          // Get manual control over the async iterator
          const iterator: AsyncIterator<any> = stream[Symbol.asyncIterator]();

          // Race: first .next() call vs timeout
          const firstResult = await Promise.race([
            iterator.next(),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`TIMEOUT:${model}`)), timeoutMs)
            ),
          ]);

          // First token arrived in time — model is responsive
          if (i > 0) {
            fallbackUsed = true;
            console.log(`[OllamaService] ⚡ Fell back to ${model} (original: ${originalModel})`);
          } else {
            console.log(`[OllamaService] ✅ Model ${model} responded within ${timeoutMs}ms`);
          }

          // Yield metadata chunk so the server/client knows which model is active
          yield `[META:{"model":"${model}","fallback":${fallbackUsed},"originalModel":"${originalModel}"}]`;

          // Yield the first content chunk we already pulled
          const firstValue = (firstResult as IteratorResult<any>).value;
          if (firstValue?.message?.content) {
            yield firstValue.message.content;
          }

          // Continue streaming the rest
          let result = await iterator.next();
          while (!result.done) {
            if (result.value?.message?.content) {
              yield result.value.message.content;
            }
            result = await iterator.next();
          }
          return; // Success
        } catch (error: any) {
          lastError = error;
          const isTimeout = error?.message?.startsWith('TIMEOUT:');
          if (isTimeout) {
            console.warn(`[OllamaService] ⏱️ Model ${model} timed out after ${timeoutMs}ms, falling back...`);
          } else {
            console.warn(`[OllamaService] ❌ Model ${model} failed: ${error?.message}, falling back...`);
          }
          continue;
        }
      }

      throw new Error(`All models in fallback chain failed. Last error: ${lastError?.message}`);
    } finally {
      this.releaseSlot();
    }
  }

  /**
   * Buffered chat with automatic model fallback.
   */
  public async chatWithFallback(messages: ChatMessage[], options: { model?: string } = {}): Promise<FallbackResult> {
    const chunks: string[] = [];
    let usedModel = this.defaultModel;
    let fallbackUsed = false;
    const originalModel = this.getAvailableFallbackChain()[0]?.model || this.defaultModel;

    for await (const chunk of this.chatStreamWithFallback(messages, options)) {
      if (chunk.startsWith('[META:')) {
        try {
          const meta = JSON.parse(chunk.slice(6, -1));
          usedModel = meta.model;
          fallbackUsed = meta.fallback;
        } catch {}
      } else {
        chunks.push(chunk);
      }
    }

    return {
      content: chunks.join(''),
      model: usedModel,
      fallbackUsed,
      originalModel,
    };
  }

  /**
   * Send a prompt to the local Ollama API (no fallback).
   */
  public async generate(prompt: string, options: { model?: string; system?: string; template?: string } = {}): Promise<ServiceResponse> {
    await this.acquireSlot();
    try {
      const response = await this.client.generate({
        model: options.model || this.defaultModel,
        prompt: prompt,
        system: options.system,
        template: options.template,
        keep_alive: config.ollama.keepAlive,
        options: this.buildOptions(),
      });

      return {
        content: response.response,
        model: response.model
      };
    } finally {
      this.releaseSlot();
    }
  }

  /**
   * Chat-based interaction (Buffered, no fallback).
   */
  public async chat(messages: ChatMessage[], options: { model?: string } = {}): Promise<ServiceResponse> {
    await this.acquireSlot();
    try {
      const response = await this.client.chat({
        model: options.model || this.defaultModel,
        messages: messages,
        keep_alive: config.ollama.keepAlive,
        options: this.buildOptions(),
      });

      return {
        content: response.message.content,
        model: response.model
      };
    } finally {
      this.releaseSlot();
    }
  }

  /**
   * Streaming version of chat (no fallback).
   */
  public async *chatStream(messages: ChatMessage[], options: { model?: string } = {}): AsyncGenerator<string> {
    await this.acquireSlot();
    try {
      const response = await this.client.chat({
        model: options.model || this.defaultModel,
        messages: messages,
        stream: true,
        keep_alive: config.ollama.keepAlive,
        options: this.buildOptions(),
      });

      for await (const part of response) {
        if (part.message && part.message.content) {
          yield part.message.content;
        }
      }
    } finally {
      this.releaseSlot();
    }
  }

  /**
   * Streaming version of generate (no fallback).
   */
  public async *generateStream(prompt: string, options: { model?: string; system?: string } = {}): AsyncGenerator<string> {
    await this.acquireSlot();
    try {
      const response = await this.client.generate({
        model: options.model || this.defaultModel,
        prompt: prompt,
        system: options.system,
        stream: true,
        keep_alive: config.ollama.keepAlive,
        options: this.buildOptions(),
      });

      for await (const part of response) {
        if (part.response) {
          yield part.response;
        }
      }
    } finally {
      this.releaseSlot();
    }
  }

  public async listModels() {
    return await this.client.list();
  }

  /**
   * Preload all models in the fallback chain into memory.
   */
  public async preloadModels(): Promise<void> {
    const chain = this.getAvailableFallbackChain();
    console.log(`[OllamaService] Preloading ${chain.length} models into memory...`);
    
    for (const { model } of chain) {
      try {
        console.log(`[OllamaService] Preloading: ${model}...`);
        await this.client.generate({
          model,
          prompt: '',
          keep_alive: config.ollama.keepAlive,
          options: { num_predict: 1 },
        });
        console.log(`[OllamaService] ✅ ${model} loaded and warm.`);
      } catch (error) {
        console.warn(`[OllamaService] ⚠️ Preload failed for ${model} (may not be pulled):`, error);
      }
    }
  }

  public getFallbackChainInfo() {
    return this.getAvailableFallbackChain().map(e => ({
      model: e.model,
      timeoutMs: e.timeoutMs,
    }));
  }
}

export const ollamaService = new OllamaService();
