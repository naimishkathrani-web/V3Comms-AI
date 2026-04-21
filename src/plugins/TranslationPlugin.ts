import { BasePlugin, PluginMetadata } from '../core/BasePlugin.js';
import { ollamaService } from '../services/OllamaService.js';

export default class TranslationPlugin extends BasePlugin {
  public readonly metadata: PluginMetadata = {
    name: 'translator',
    version: '2.0.0',
    description: 'Advanced LLM translator for Hindi, Gujarati, Hinglish, and English.',
    supportedActions: ['translate']
  };

  private systemPrompt: string = `
    You are a professional translator and linguist specialized in Indian languages.
    Your task is to translate text accurately while preserving tone, cultural context, and nuances.
    
    Supported languages:
    - English
    - Hindi (हिंदी)
    - Gujarati (ગુજરાતી)
    - Hinglish (Hindi written in Roman script/Transliterated Hindi, mixed with English)

    Instructions:
    1. Only provide the translated text. No explanations or intro/outro.
    2. If the target is Hinglish, use natural, colloquial Romanized Hindi mixed with common English words as used in modern messaging applications.
    3. Maintain the professional or casual tone of the source text.
  `;

  public async init(): Promise<void> {
    console.log('[TranslationPlugin] Ready to translate.');
  }

  public async execute(action: string, data: any): Promise<any> {
    if (action === 'translate') {
      const { text, targetLang, sourceLang, model } = data;

      if (!text || !targetLang) {
        throw new Error('Text and targetLang are required for translation.');
      }

      const prompt = `Translate the following text to ${targetLang}${sourceLang ? ` from ${sourceLang}` : ''}:\n\n"${text}"`;

      try {
        const response = await ollamaService.generate(prompt, {
          system: this.systemPrompt,
          model: model // Allow model override
        });

        return {
          original: text,
          translated: response.content.trim(),
          sourceLang: sourceLang || 'auto-detected',
          targetLang: targetLang,
          model: response.model
        };
      } catch (error: any) {
        throw new Error(`Translation failure: ${error.message}`);
      }
    }
    throw new Error(`Action "${action}" not supported.`);
  }

  public async *executeStream(action: string, data: any): AsyncGenerator<string> {
    if (action === 'translate') {
      const { text, targetLang, sourceLang, model } = data;
      const prompt = `Translate the following text to ${targetLang}${sourceLang ? ` from ${sourceLang}` : ''}:\n\n"${text}"`;
      yield* ollamaService.generateStream(prompt, { system: this.systemPrompt, model });
      return;
    }
    throw new Error(`Action "${action}" does not support streaming.`);
  }

  public async shutdown(): Promise<void> {
    console.log('[TranslationPlugin] Shutting down.');
  }
}
