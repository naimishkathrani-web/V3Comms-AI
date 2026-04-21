/**
 * V3CommsClient - Official JavaScript SDK for v3comms-ai
 * 
 * Easy-to-use client for multilingual chat and translation.
 */
export class V3CommsClient {
  /**
   * @param {string} baseUrl The base URL of your v3comms-ai server (e.g. http://localhost:3000)
   */
  constructor(baseUrl) {
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  }

  /**
   * Send a chat message to the V3 AI Agent.
   * @param {string} message The user's message.
   * @param {Object} options Optional parameters (history, context, model).
   * @returns {Promise<Object>} The agent's response.
   */
  async chat(message, options = {}) {
    const response = await fetch(`${this.baseUrl}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        history: options.history || [],
        context: options.context,
        model: options.model
      })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Chat failed');
    return data;
  }

  /**
   * Translate text between supported languages.
   * @param {string} text The text to translate.
   * @param {string} targetLang The target language (e.g. "Hindi", "Gujarati", "Hinglish").
   * @param {Object} options Optional parameters (sourceLang, model).
   * @returns {Promise<Object>} The translated text.
   */
  async translate(text, targetLang, options = {}) {
    const response = await fetch(`${this.baseUrl}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        targetLang,
        sourceLang: options.sourceLang,
        model: options.model
      })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Translation failed');
    return data;
  }

  /**
   * Get the list of active plugins and their capabilities.
   * @returns {Promise<Array>} List of plugins.
   */
  async getPlugins() {
    const response = await fetch(`${this.baseUrl}/api/plugins`);
    return await response.json();
  }

  /**
   * Health check for the server.
   * @returns {Promise<Object>} Server status.
   */
  async health() {
    const response = await fetch(`${this.baseUrl}/health`);
    return await response.json();
  }
}
