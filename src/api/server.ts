import express, { Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config/index.js';
import { PluginManager } from '../core/PluginManager.js';

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

// Initialize Plugins dynamically
const setupSystem = async () => {
  try {
    // Determine the plugins directory (relative to current file)
    const pluginsDir = path.join(__dirname, '../plugins');
    
    // Load all plugins from the folder
    await pluginManager.loadPlugins(pluginsDir);

    // Boot everything
    await pluginManager.boot();
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

/**
 * Dedicated Chat Endpoint (SaaS-friendly)
 * POST /chat
 * Body: { message: string, history?: [], context?: string }
 */
app.post('/chat', async (req: Request, res: Response) => {
  const { message, history, context, model, stream } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }

  try {
    const messages = history || [];
    messages.push({ role: 'user', content: message });

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      for await (const chunk of pluginManager.executeStream('agent', 'chat', { messages, context, model })) {
        res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    const result = await pluginManager.execute('agent', 'chat', { messages, context, model });
    res.json({ success: true, response: result.response, model: result.model });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/translate', async (req: Request, res: Response) => {
  const { text, targetLang, sourceLang, model, stream } = req.body;

  if (!text || !targetLang) {
    return res.status(400).json({ error: 'text and targetLang are required' });
  }

  try {
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      for await (const chunk of pluginManager.executeStream('translator', 'translate', { text, targetLang, sourceLang, model })) {
        res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    const result = await pluginManager.execute('translator', 'translate', { text, targetLang, sourceLang, model });
    res.json({ success: true, translated: result.translated, sourceLang: result.sourceLang, model: result.model });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Universal Action Execution Endpoint
 * POST /api/execute
 * Body: { plugin: 'ollama', action: 'chat', data: { ... } }
 */
app.post('/api/execute', async (req: Request, res: Response) => {
  const { plugin, action, data } = req.body;

  if (!plugin || !action) {
    return res.status(400).json({ error: 'Plugin and action are required' });
  }

  try {
    const result = await pluginManager.execute(plugin, action, data || {});
    res.json({ success: true, result });
  } catch (error: any) {
    console.error(`[API] Error executing ${plugin}/${action}:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Start
const start = async () => {
  await setupSystem();
  app.listen(config.port, () => {
    console.log(`[Server] v3comms-ai (v2) at http://localhost:${config.port}`);
  });
};

start();
