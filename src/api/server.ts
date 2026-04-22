import express, { Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config/index.js';
import { PluginManager } from '../core/PluginManager.js';
import { ollamaService } from '../services/OllamaService.js';
import { builderService } from '../services/BuilderService.js';

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

app.get('/api/fallback-chain', (req: Request, res: Response) => {
  res.json({
    chain: ollamaService.getFallbackChainInfo(),
    defaultModel: config.ollama.model,
  });
});

/**
 * Dedicated Chat Endpoint with Model Fallback
 * POST /chat
 * Body: { message: string, history?: [], context?: string, model?: string, stream?: boolean }
 * Uses fallback chain by default. Specify model to skip fallback.
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

      // Use fallback streaming — tries fastest model first
      for await (const chunk of ollamaService.chatStreamWithFallback(
        [{ role: 'system', content: getSystemPrompt(context) }, ...messages],
        { model }
      )) {
        // Parse META chunks to send model info to client
        if (chunk.startsWith('[META:')) {
          try {
            const meta = JSON.parse(chunk.slice(6, -1));
            res.write(`data: ${JSON.stringify({ type: 'meta', model: meta.model, fallback: meta.fallback, originalModel: meta.originalModel })}\n\n`);
          } catch {}
        } else {
          res.write(`data: ${JSON.stringify({ type: 'content', chunk })}\n\n`);
        }
      }
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    // Buffered response with fallback
    const result = await ollamaService.chatWithFallback(
      [{ role: 'system', content: getSystemPrompt(context) }, ...messages],
      { model }
    );
    res.json({
      success: true,
      response: result.content,
      model: result.model,
      fallbackUsed: result.fallbackUsed,
      originalModel: result.originalModel,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

function getSystemPrompt(context?: string): string {
  const base = `You are "V3 AI", a friendly, polite, and helpful digital assistant specialized for Indian users.
Guidelines:
1. Tone: Warm, respectful, and culturally aware (use "Ji", "Namaste", "Hello Bhai", etc. appropriately).
2. Language: You are multilingual. Auto-detect the user's language and respond in the same.
3. Hinglish: If the user speaks in Hinglish, respond in natural, fluent Hinglish.
4. Support/Marketing: While your current role is a general assistant, keep your responses structured so you can provide helpful information about products or support issues if asked.
5. Knowledge: You have deep knowledge of Indian culture, festivals, and geography.
6. Concision: Be helpful but don't be overly wordy unless asked.`;
  return context ? base + `\nContext: ${context}` : base;
}

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
/**
 * Builder Chat Endpoint — AI coding assistant with tool use
 * POST /api/builder/chat
 * Body: { message: string }
 */
app.post('/api/builder/chat', async (req: Request, res: Response) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Message is required' });

  try {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    for await (const chunk of builderService.chatStream(message)) {
      if (chunk.startsWith('[META:')) {
        try {
          const meta = JSON.parse(chunk.slice(6, -1));
          res.write(`data: ${JSON.stringify({ type: 'meta', model: meta.model, fallback: meta.fallback, originalModel: meta.originalModel })}\n\n`);
        } catch {}
      } else if (chunk.startsWith('[EXECUTING:')) {
        res.write(`data: ${JSON.stringify({ type: 'tool_start', tool: chunk.trim() })}\n\n`);
      } else if (chunk.startsWith('[TOOL_RESULT:')) {
        const toolEnd = chunk.indexOf(']');
        const toolName = chunk.slice(13, toolEnd);
        const result = chunk.slice(toolEnd + 1);
        res.write(`data: ${JSON.stringify({ type: 'tool_result', tool: toolName, result })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ type: 'content', chunk })}\n\n`);
      }
    }
    res.write('data: [DONE]\n\n');
    return res.end();
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/builder/tasks', (req: Request, res: Response) => {
  res.json({ tasks: builderService.getTasks() });
});

app.get('/api/builder/files', (req: Request, res: Response) => {
  const dir = (req.query.dir as string) || '.';
  res.json({ tree: builderService.getFileTree(dir) });
});

app.post('/api/builder/reset', (req: Request, res: Response) => {
  builderService.resetConversation();
  res.json({ success: true });
});

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
