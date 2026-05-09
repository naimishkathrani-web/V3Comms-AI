import express, { Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config/index.js';
import { PluginManager } from '../core/PluginManager.js';
import { ollamaService } from '../services/OllamaService.js';
import { vectorService } from '../services/VectorService.js';
import { projectContextService } from '../services/ProjectContextService.js';
import { authMiddleware } from './middleware.js';
import { createChatRoutes } from './routes/chatRoutes.js';
import { builderRoutes } from './routes/builderRoutes.js';
import { knowledgeRoutes } from './routes/knowledgeRoutes.js';
import { modelRoutes } from './routes/modelRoutes.js';
import { projectRoutes } from './routes/projectRoutes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const pluginManager = new PluginManager();

// Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      "script-src": ["'self'", "https://cdn.jsdelivr.net"],
      "connect-src": ["'self'", "http://localhost:3000", "http://127.0.0.1:3000"],
    },
  },
}));
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Auth middleware on all /api routes
app.use('/api', authMiddleware);

// Rate limiting — 100 requests per minute per IP
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests, please try again later.' },
});
app.use('/api', limiter);

// Initialize Plugins dynamically
const setupSystem = async () => {
  try {
    // Determine the plugins directory (relative to current file)
    const pluginsDir = path.join(__dirname, '../plugins');
    
    // Load all plugins from the folder
    await pluginManager.loadPlugins(pluginsDir);

    // Boot everything
    await pluginManager.boot();

    // Connect to pgvector (non-blocking — won't fail startup if DB is unreachable)
    const dbConnected = await vectorService.connect();
    if (dbConnected) {
      console.log('[Server] pgvector knowledge base connected');
      // Initialize project context service
      projectContextService.setPool(vectorService.getPool()!);
      await projectContextService.initialize();
    } else {
      console.warn('[Server] pgvector unavailable — knowledge features disabled');
    }
  } catch (error) {
    console.error('Failed to setup system:', error);
    process.exit(1);
  }
};

// Discovery/Dashboard Route
app.get('/', (req: Request, res: Response) => {
  // If the request accepts HTML, serve the dashboard
  if (req.accepts('html')) {
    return res.sendFile(path.join(__dirname, '../../public/index.html'));
  }
  
  // Otherwise serve the JSON metadata
  res.json({
    name: 'v3comms-ai',
    version: '2.0.0',
    description: 'Modular AI Communication Engine',
    status: 'Operational',
    endpoints: {
      discovery: '/api/plugins',
      health: '/health',
      chat: '/chat',
      translate: '/translate',
      universal: '/api/execute'
    },
    documentation: 'https://github.com/v3comms-ai'
  });
});

// API Endpoints
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'OK', uptime: process.uptime() });
});

app.get('/api/plugins', (req: Request, res: Response) => {
  res.json(pluginManager.listPlugins());
});

app.get('/api/fallback-chain', (req: Request, res: Response) => {
  res.json({
    chain: ollamaService.getFallbackChainInfo(),
    defaultModel: config.ollama.model,
  });
});

// Mount route modules
app.use(createChatRoutes(pluginManager));
app.use(builderRoutes);
app.use(knowledgeRoutes);
app.use(modelRoutes);
app.use(projectRoutes);

// Start
const start = async () => {
  await setupSystem();
  app.listen(config.port, () => {
    console.log(`[Server] v3comms-ai (v2) at http://localhost:${config.port}`);
  });
};

start();
