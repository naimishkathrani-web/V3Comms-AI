import { BasePlugin, PluginMetadata } from '../core/BasePlugin.js';
import { ollamaService, ChatMessage } from '../services/OllamaService.js';

export default class AgentPlugin extends BasePlugin {
  public readonly metadata: PluginMetadata = {
    name: 'agent',
    version: '1.0.0',
    description: 'Multilingual friendly chat agent for Indian users.',
    supportedActions: ['chat']
  };

  private baseSystemPrompt: string = `
    You are "V3 AI", a friendly, polite, and helpful digital assistant specialized for Indian users.
    
    Guidelines:
    1. Tone: Warm, respectful, and culturally aware (use "Ji", "Namaste", "Hello Bhai", etc. appropriately).
    2. Language: You are multilingual. Auto-detect the user's language and respond in the same.
    3. Hinglish: If the user speaks in Hinglish, respond in natural, fluent Hinglish.
    4. Support/Marketing: While your current role is a general assistant, keep your responses structured so you can provide helpful information about products or support issues if asked.
    5. Knowledge: You have deep knowledge of Indian culture, festivals, and geography.
    6. Concision: Be helpful but don't be overly wordy unless asked.
  `;

  public async init(): Promise<void> {
    console.log('[AgentPlugin] V3 AI is online and ready to help.');
  }

  public async execute(action: string, data: any): Promise<any> {
    if (action === 'chat') {
      const { messages, context, model } = data;

      if (!messages || !Array.isArray(messages)) {
        throw new Error('Messages array is required for chat action.');
      }

      // Inject system prompt if not present at the start
      const chatMessages: ChatMessage[] = [
        { role: 'system', content: this.baseSystemPrompt + (context ? `\nContext: ${context}` : '') },
        ...messages
      ];

      try {
        const response = await ollamaService.chat(chatMessages, {
          model: model
        });

        return {
          response: response.content,
          model: response.model,
          timestamp: new Date().toISOString()
        };
      } catch (error: any) {
        throw new Error(`Agent chat failure: ${error.message}`);
      }
    }
    throw new Error(`Action "${action}" not supported.`);
  }

  public async *executeStream(action: string, data: any): AsyncGenerator<string> {
    if (action === 'chat') {
      const { messages, context, model } = data;
      const chatMessages = [
        { role: 'system', content: this.baseSystemPrompt + (context ? `\nContext: ${context}` : '') },
        ...(messages || [])
      ];

      yield* ollamaService.chatStream(chatMessages, { model });
      return;
    }
    throw new Error(`Action "${action}" does not support streaming.`);
  }

  public async shutdown(): Promise<void> {
    console.log('[AgentPlugin] Signing off. Phir milenge!');
  }
}
