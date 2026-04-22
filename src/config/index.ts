import dotenv from 'dotenv';
dotenv.config();

export interface ModelFallbackEntry {
  model: string;
  timeoutMs: number; // Max ms to wait for first token before falling back
}

export const config = {
  port: process.env.PORT || 3000,
  ollama: {
    host: process.env.OLLAMA_HOST || 'http://localhost:11434',
    model: process.env.OLLAMA_MODEL || 'llama3.2:1b',
    keepAlive: process.env.OLLAMA_KEEP_ALIVE || '24h',
    // Performance tuning - smaller values = faster inference on CPU
    numCtx: parseInt(process.env.OLLAMA_NUM_CTX || '2048'),
    numPredict: parseInt(process.env.OLLAMA_NUM_PREDICT || '256'),
    temperature: parseFloat(process.env.OLLAMA_TEMPERATURE || '0.7'),
    topK: parseInt(process.env.OLLAMA_TOP_K || '40'),
    topP: parseFloat(process.env.OLLAMA_TOP_P || '0.9'),
    // Model fallback chain: ordered fastest → best quality
    // timeoutMs = max wait for first token before falling back to next model
    fallbackChain: (process.env.OLLAMA_FALLBACK_CHAIN || 'llama3.2:1b:3000,qwen2.5:1.5b:3000,tinyllama:latest:2000,gemma2:2b:3000,phi3.5:latest:4000,mistral:latest:5000')
      .split(',').map((entry: string) => {
        const lastColon = entry.lastIndexOf(':');
        const model = entry.slice(0, lastColon);
        const timeoutMs = parseInt(entry.slice(lastColon + 1)) || 3000;
        return { model, timeoutMs };
      }) as ModelFallbackEntry[],
  },
  maxConcurrentRequests: parseInt(process.env.MAX_CONCURRENT_REQUESTS || '1'),
  env: process.env.NODE_ENV || 'development',
};
