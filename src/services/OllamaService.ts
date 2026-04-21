import { Ollama } from 'ollama';
import { config } from '../config/index.js';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ServiceResponse {
  content: string;
  model: string;
}

export class OllamaService {
  private client: Ollama;
  private defaultModel: string;

  constructor(host?: string, defaultModel?: string) {
    const ollamaHost = host || config.ollama.host;
    this.defaultModel = defaultModel || config.ollama.model;
    
    this.client = new Ollama({ host: ollamaHost });
    console.log(`[OllamaService] Initialized with host: ${ollamaHost}`);
  }

  /**
   * Basic health check for the Ollama connection.
   */
  public async checkConnection(): Promise<boolean> {
    try {
      await this.client.list();
      return true;
    } catch (error) {
      console.warn('[OllamaService] Connection check failed:', error);
      return false;
    }
  }

  /**
   * Send a prompt to the local Ollama API.
   * Flexible for agents; doesn't hardcode prompts.
   */
  public async generate(prompt: string, options: { model?: string; system?: string; template?: string } = {}): Promise<ServiceResponse> {
    const response = await this.client.generate({
      model: options.model || this.defaultModel,
      prompt: prompt,
      system: options.system,
      template: options.template
    });

    return {
      content: response.response,
      model: response.model
    };
  }

  /**
   * Chat-based interaction.
   */
  /**
   * Chat-based interaction (Buffered).
   */
  public async chat(messages: ChatMessage[], options: { model?: string } = {}): Promise<ServiceResponse> {
    const response = await this.client.chat({
      model: options.model || this.defaultModel,
      messages: messages,
      keep_alive: config.ollama?.keepAlive || '5m'
    });

    return {
      content: response.message.content,
      model: response.model
    };
  }

  /**
   * Streaming version of chat.
   */
  public async *chatStream(messages: ChatMessage[], options: { model?: string } = {}): AsyncGenerator<string> {
    const response = await this.client.chat({
      model: options.model || this.defaultModel,
      messages: messages,
      stream: true,
      keep_alive: config.ollama?.keepAlive || '5m'
    });

    for await (const part of response) {
      if (part.message && part.message.content) {
        yield part.message.content;
      }
    }
  }

  /**
   * Streaming version of generate.
   */
  public async *generateStream(prompt: string, options: { model?: string; system?: string } = {}): AsyncGenerator<string> {
    const response = await this.client.generate({
      model: options.model || this.defaultModel,
      prompt: prompt,
      system: options.system,
      stream: true,
      keep_alive: config.ollama?.keepAlive || '5m'
    });

    for await (const part of response) {
      if (part.response) {
        yield part.response;
      }
    }
  }

  /**
   * List available local models.
   */
  public async listModels() {
    return await this.client.list();
  }
}

// Export a singleton instance for easy reuse if needed, 
// though plugins can also instantiate their own.
export const ollamaService = new OllamaService();
