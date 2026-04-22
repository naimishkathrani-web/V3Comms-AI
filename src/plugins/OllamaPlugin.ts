import { BasePlugin, PluginMetadata } from '../core/BasePlugin.js';
import { ollamaService } from '../services/OllamaService.js';

export default class OllamaPlugin extends BasePlugin {
  public readonly metadata: PluginMetadata = {
    name: 'ollama',
    version: '2.0.0',
    description: 'Local LLM capabilities powered by a reusable OllamaService',
    supportedActions: ['chat', 'generate', 'listModels']
  };

  public async init(): Promise<void> {
    const isConnected = await ollamaService.checkConnection();
    if (isConnected) {
      console.log('[OllamaPlugin] Successfully linked to OllamaService.');
      // Preload model into memory to eliminate cold-start delay
      await ollamaService.preloadModels();
    } else {
      console.warn('[OllamaPlugin] Could not connect to Ollama service during init.');
    }
  }

  public async execute(action: string, data: any): Promise<any> {
    switch (action) {
      case 'chat':
        return await ollamaService.chat(data.messages, data.options);
      case 'generate':
        return await ollamaService.generate(data.prompt, data.options);
      case 'listModels':
        return await ollamaService.listModels();
      default:
        throw new Error(`Action "${action}" not recognized by OllamaPlugin.`);
    }
  }

  public async shutdown(): Promise<void> {
    console.log('[OllamaPlugin] Shutting down.');
  }
}
