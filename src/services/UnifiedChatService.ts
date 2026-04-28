import { modelConfigService, ModelConfig } from './ModelConfigService.js';
import { cloudModelProvider } from './CloudModelProvider.js';
import { ollamaService } from './OllamaService.js';
import { ChatMessage, FallbackResult } from './OllamaService.js';

export interface UnifiedChatOptions {
  messages: ChatMessage[];
  model?: string;       // specific model id, or "auto"
  stream?: boolean;
  maxTokens?: number;
  temperature?: number;
}

class UnifiedChatService {
  /**
   * Chat with auto-fallback across cloud → local models.
   * If model is "auto" or undefined, tries each enabled model in priority order.
   * If model is a specific id, uses only that model.
   */
  async chat(opts: UnifiedChatOptions): Promise<FallbackResult> {
    const { messages, stream, maxTokens, temperature } = opts;

    // Determine which models to try
    const requestedModel = opts.model || 'auto';
    let modelsToTry: ModelConfig[];

    if (requestedModel === 'auto') {
      modelsToTry = modelConfigService.getActiveChain();
    } else {
      const specific = modelConfigService.getModel(requestedModel);
      if (specific) {
        modelsToTry = [specific];
      } else {
        // Might be an Ollama model id not in config — try directly
        return ollamaService.chatWithFallback(
          messages,
          { model: requestedModel }
        );
      }
    }

    if (modelsToTry.length === 0) {
      // Fallback to Ollama default
      return ollamaService.chatWithFallback(messages, {});
    }

    const originalModel = modelsToTry[0].modelId;
    let lastError: string = '';

    for (const model of modelsToTry) {
      try {
        if (model.type === 'cloud') {
          if (!model.apiKey) continue;
          const result = await cloudModelProvider.chat({
            model,
            messages,
            maxTokens,
            temperature,
          });
          result.fallbackUsed = result.model !== originalModel;
          result.originalModel = originalModel;
          return result;
        } else {
          // Local (Ollama)
          const result = await ollamaService.chatWithFallback(
            messages,
            { model: model.modelId }
          );
          result.fallbackUsed = result.model !== originalModel;
          result.originalModel = originalModel;
          return result;
        }
      } catch (e: any) {
        lastError = e.message;
        console.warn(`[UnifiedChat] ${model.name} (${model.modelId}) failed: ${e.message}`);
        continue; // Try next model
      }
    }

    throw new Error(`All models failed. Last error: ${lastError}`);
  }

  /**
   * Stream chat with auto-fallback across cloud → local models.
   */
  async *chatStream(opts: UnifiedChatOptions): AsyncGenerator<string> {
    const { messages, maxTokens, temperature } = opts;

    const requestedModel = opts.model || 'auto';
    let modelsToTry: ModelConfig[];

    if (requestedModel === 'auto') {
      modelsToTry = modelConfigService.getActiveChain();
    } else {
      const specific = modelConfigService.getModel(requestedModel);
      if (specific) {
        modelsToTry = [specific];
      } else {
        // Direct Ollama model
        yield* ollamaService.chatStreamWithFallback(
          messages,
          { model: requestedModel }
        );
        return;
      }
    }

    if (modelsToTry.length === 0) {
      yield* ollamaService.chatStreamWithFallback(messages, {});
      return;
    }

    // Try cloud models first (they don't support our yield* fallback pattern)
    for (const model of modelsToTry) {
      if (model.type === 'cloud' && model.apiKey) {
        try {
          // Emit meta event so client knows which model is active
          yield `[META:{"model":"${model.modelId}","fallback":false,"originalModel":"${modelsToTry[0].modelId}"}]`;
          yield* cloudModelProvider.chatStream({
            model,
            messages,
            maxTokens,
            temperature,
          });
          return; // Success — done
        } catch (e: any) {
          console.warn(`[UnifiedChat] Stream ${model.name} failed: ${e.message}`);
          continue;
        }
      }
    }

    // Fall back to Ollama streaming with built-in fallback chain
    const localModels = modelsToTry.filter(m => m.type === 'local');
    if (localModels.length > 0) {
      const firstLocal = localModels[0].modelId;
      yield `[META:{"model":"${firstLocal}","fallback":true,"originalModel":"${modelsToTry[0].modelId}"}]`;
      yield* ollamaService.chatStreamWithFallback(messages, { model: firstLocal });
      return;
    }

    // Last resort — default Ollama
    yield* ollamaService.chatStreamWithFallback(messages, {});
  }
}

export const unifiedChatService = new UnifiedChatService();
