import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: process.env.PORT || 3000,
  ollama: {
    host: process.env.OLLAMA_HOST || 'http://localhost:11434',
    model: process.env.OLLAMA_MODEL || 'mistral',
    keepAlive: process.env.OLLAMA_KEEP_ALIVE || '24h' // Optimization: Keep models in memory
  },
  env: process.env.NODE_ENV || 'development',
};
