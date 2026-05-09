import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '../..');

// Load .env first (base config)
const envPath = join(projectRoot, '.env');
console.log(`[Config] Loading .env from: ${envPath}`);
console.log(`[Config] .env exists: ${existsSync(envPath)}`);
dotenv.config({ path: envPath });

// Load .env.local (local overrides with secrets)
const envLocalPath = join(projectRoot, '.env.local');
if (existsSync(envLocalPath)) {
  console.log(`[Config] Loading .env.local from: ${envLocalPath}`);
  dotenv.config({ path: envLocalPath });
}

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
    numBatch: parseInt(process.env.OLLAMA_NUM_BATCH || '512'),
    numThread: parseInt(process.env.OLLAMA_NUM_THREAD || '0'), // 0 = auto-detect
    numGpu: parseInt(process.env.OLLAMA_NUM_GPU || '0'), // 0 = CPU only
    flashAttention: process.env.OLLAMA_FLASH_ATTENTION === 'true',
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
  apiAuthToken: process.env.API_AUTH_TOKEN || '', // Empty = auth disabled (dev mode)
  env: process.env.NODE_ENV || 'development',
  builderModel: process.env.BUILDER_MODEL || 'phi3.5:latest',
  embeddingModel: process.env.EMBEDDING_MODEL || 'nomic-embed-text',
  pg: {
    host: process.env.PG_HOST || '127.0.0.1',
    port: parseInt(process.env.PG_PORT || '15432'),
    database: process.env.PG_DATABASE || 'V3CommsAI',
    user: process.env.PG_USER || 'postgres',
    password: process.env.PG_PASSWORD || '',
  },
  ssh: {
    host: process.env.SSH_HOST || '',
    port: parseInt(process.env.SSH_PORT || '22'),
    username: process.env.SSH_USER || '',
    password: process.env.SSH_PASSWORD || '',
  },
};
