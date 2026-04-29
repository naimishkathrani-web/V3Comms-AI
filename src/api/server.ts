import express, { Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config/index.js';
import { PluginManager } from '../core/PluginManager.js';
import { ollamaService } from '../services/OllamaService.js';
import { builderService } from '../services/BuilderService.js';
import { vectorService, KnowledgeFilters } from '../services/VectorService.js';
import { ingestionService } from '../services/IngestionService.js';
import { knowledgeIntakeService } from '../services/KnowledgeIntakeService.js';
import { modelConfigService } from '../services/ModelConfigService.js';
import { cloudModelProvider } from '../services/CloudModelProvider.js';
import { unifiedChatService } from '../services/UnifiedChatService.js';
import { projectContextService } from '../services/ProjectContextService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const pluginManager = new PluginManager();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

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

app.post('/chat', async (req: Request, res: Response) => {
  const { message, history, context, model, stream, role, category, subCategory, company, project, commodity, tags } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }

  try {
    const messages = Array.isArray(history) ? [...history] : [];
    messages.push({ role: 'user', content: message });

    let ragContext = '';
    let knowledgeFilters: KnowledgeFilters | null = null;
    let knowledgeResults: Awaited<ReturnType<typeof vectorService.search>> = [];

    if (vectorService.isConnected()) {
      try {
        knowledgeFilters = {
          role: normalizeOptionalString(role) || undefined,
          category: normalizeOptionalString(category) || undefined,
          subCategory: normalizeOptionalString(subCategory) || undefined,
          company: normalizeOptionalString(company) || undefined,
          project: normalizeOptionalString(project) || undefined,
          commodity: normalizeOptionalString(commodity) || undefined,
          tags: parseTags(tags),
        };

        // Only infer filters if user didn't provide any
        const hasUserFilters = knowledgeFilters.role || knowledgeFilters.category || knowledgeFilters.subCategory || knowledgeFilters.company || knowledgeFilters.project || knowledgeFilters.commodity || (knowledgeFilters.tags && knowledgeFilters.tags.length > 0);
        if (!hasUserFilters) {
          knowledgeFilters = await knowledgeIntakeService.inferFiltersFromPrompt(message);
        }

        knowledgeResults = await vectorService.search(message, 5, 0.2, knowledgeFilters || {});
        
        // Fallback: if filtered search returns nothing, try unfiltered search
        if (knowledgeResults.length === 0) {
          const unfilteredResults = await vectorService.search(message, 5, 0.2, {});
          if (unfilteredResults.length > 0) {
            knowledgeResults = unfilteredResults;
            knowledgeFilters = null; // Clear filters since we're using unfiltered results
          }
        }
        if (knowledgeResults.length > 0) {
          const filterSummary = knowledgeFilters?.role || knowledgeFilters?.category || knowledgeFilters?.subCategory || knowledgeFilters?.company || knowledgeFilters?.project || knowledgeFilters?.commodity
            ? `\nActive filters: ${[
              knowledgeFilters?.role ? `role=${knowledgeFilters.role}` : '',
              knowledgeFilters?.category ? `category=${knowledgeFilters.category}` : '',
              knowledgeFilters?.subCategory ? `sub_category=${knowledgeFilters.subCategory}` : '',
              knowledgeFilters?.company ? `company=${knowledgeFilters.company}` : '',
              knowledgeFilters?.project ? `project=${knowledgeFilters.project}` : '',
              knowledgeFilters?.commodity ? `commodity=${knowledgeFilters.commodity}` : '',
            ].filter(Boolean).join(', ')}`
            : '';

          ragContext = '\n\n[KNOWLEDGE BASE — relevant information]' + filterSummary + ':\n' +
            knowledgeResults.map((r, i) => {
              const metadata = [
                r.metadata?.role ? `role: ${r.metadata.role}` : '',
                r.metadata?.category ? `category: ${r.metadata.category}` : '',
                r.metadata?.sub_category ? `sub_category: ${r.metadata.sub_category}` : '',
                r.metadata?.company ? `company: ${r.metadata.company}` : '',
                r.metadata?.project ? `project: ${r.metadata.project}` : '',
                r.metadata?.commodity ? `commodity: ${r.metadata.commodity}` : '',
                Array.isArray(r.metadata?.tags) && r.metadata.tags.length > 0 ? `tags: ${r.metadata.tags.join(', ')}` : '',
              ].filter(Boolean).join(', ');
              return `${i + 1}. (from ${r.source_type}: ${r.source_path}, similarity: ${r.similarity.toFixed(2)}${metadata ? `, ${metadata}` : ''})\n${r.chunk_text}`;
            }).join('\n\n');
        }
      } catch {
        knowledgeFilters = null;
      }
    }

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      if (knowledgeFilters) {
        res.write(`data: ${JSON.stringify({ type: 'knowledge', filters: knowledgeFilters, hits: knowledgeResults.length })}\n\n`);
      }

      for await (const chunk of unifiedChatService.chatStream({
        messages: [{ role: 'system', content: getSystemPrompt(context, knowledgeFilters) + ragContext }, ...messages],
        model: model || 'auto',
      })) {
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

    const result = await unifiedChatService.chat({
      messages: [{ role: 'system', content: getSystemPrompt(context, knowledgeFilters) + ragContext }, ...messages],
      model: model || 'auto',
    });
    res.json({
      success: true,
      response: result.content,
      model: result.model,
      fallbackUsed: result.fallbackUsed,
      originalModel: result.originalModel,
      knowledgeFilters,
      knowledgeHits: knowledgeResults.length,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

function getSystemPrompt(context?: string, knowledgeFilters?: KnowledgeFilters | null): string {
  const base = `You are "V3 AI", a friendly, polite, and helpful digital assistant specialized for Indian users.
Guidelines:
1. Tone: Warm, respectful, and culturally aware (use "Ji", "Namaste", "Hello Bhai", etc. appropriately).
2. Language: You are multilingual. Auto-detect the user's language and respond in the same.
3. Hinglish: If the user speaks in Hinglish, respond in natural, fluent Hinglish.
4. Support/Marketing: While your current role is a general assistant, keep your responses structured so you can provide helpful information about products or support issues if asked.
5. Knowledge: You have deep knowledge of Indian culture, festivals, and geography.
6. Concision: Be helpful but don't be overly wordy unless asked.
7. KNOWLEDGE BASE PRIORITY: When [KNOWLEDGE BASE] context is provided below, you MUST use it as the primary source of truth. Follow the instructions, rules, and mappings in the knowledge base exactly. Do NOT ignore or override knowledge base content with your general knowledge. If the knowledge base says "Red > Blue", respond "Blue" when asked about "Red".`;
  const roleContext = knowledgeFilters?.role || knowledgeFilters?.category || knowledgeFilters?.project || knowledgeFilters?.company || knowledgeFilters?.commodity
    ? `\nRetrieved knowledge is currently focused on role "${knowledgeFilters?.role || 'General'}", category "${knowledgeFilters?.category || 'General'}", sub-category "${knowledgeFilters?.subCategory || 'General'}", company "${knowledgeFilters?.company || 'Shared'}", project "${knowledgeFilters?.project || 'Shared'}", and commodity "${knowledgeFilters?.commodity || 'General'}". Stay aligned with that domain unless the user clearly changes topic.`
    : '';
  return context ? base + roleContext + `\nContext: ${context}` : base + roleContext;
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

/**
 * Knowledge API Endpoints — pgvector RAG system
 */

// Get knowledge base stats
app.get('/api/knowledge/stats', async (req: Request, res: Response) => {
  try {
    const stats = await vectorService.getStats();
    res.json({ success: true, ...stats });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// List all ingested documents
app.get('/api/knowledge/documents', async (req: Request, res: Response) => {
  try {
    const docs = await vectorService.listDocuments();
    res.json({ success: true, documents: docs });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/knowledge/taxonomy', async (req: Request, res: Response) => {
  try {
    const taxonomy = await knowledgeIntakeService.getTaxonomy();
    res.json({ success: true, ...taxonomy });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/knowledge/intake/records', async (req: Request, res: Response) => {
  try {
    const records = await vectorService.listKnowledgeIntakeRecords();
    res.json({ success: true, records });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/knowledge/intake/classify', async (req: Request, res: Response) => {
  const { content, title, url } = req.body;
  if (!content && !url) {
    return res.status(400).json({ error: 'content or url is required' });
  }

  try {
    const result = url
      ? await knowledgeIntakeService.createUrlDraft({
          url,
          role: normalizeOptionalString(req.body.role) || undefined,
          category: normalizeOptionalString(req.body.category) || undefined,
          subCategory: normalizeOptionalString(req.body.subCategory) || undefined,
          company: normalizeOptionalString(req.body.company) || undefined,
          project: normalizeOptionalString(req.body.project) || undefined,
          commodity: normalizeOptionalString(req.body.commodity) || undefined,
          tags: parseTags(req.body.tags),
        })
      : await knowledgeIntakeService.createDraft({
          sourceType: 'text',
          title: title || 'Knowledge Draft',
          content,
          role: normalizeOptionalString(req.body.role) || undefined,
          category: normalizeOptionalString(req.body.category) || undefined,
          subCategory: normalizeOptionalString(req.body.subCategory) || undefined,
          company: normalizeOptionalString(req.body.company) || undefined,
          project: normalizeOptionalString(req.body.project) || undefined,
          commodity: normalizeOptionalString(req.body.commodity) || undefined,
          tags: parseTags(req.body.tags),
          sourcePath: `draft:${Date.now()}`,
        });

    res.json({ success: true, ...result });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/knowledge/intake/upload', upload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) {
    return res.status(400).json({ error: 'file is required' });
  }

  try {
    const content = req.file.buffer.toString('utf-8');
    if (!content.trim()) {
      return res.status(400).json({ error: 'Uploaded file has no readable text content' });
    }

    const result = await knowledgeIntakeService.createDraft({
      sourceType: 'file',
      title: req.body.title || req.file.originalname,
      content,
      role: normalizeOptionalString(req.body.role) || undefined,
      category: normalizeOptionalString(req.body.category) || undefined,
      subCategory: normalizeOptionalString(req.body.subCategory) || undefined,
      company: normalizeOptionalString(req.body.company) || undefined,
      project: normalizeOptionalString(req.body.project) || undefined,
      commodity: normalizeOptionalString(req.body.commodity) || undefined,
      tags: parseTags(req.body.tags),
      originalFileName: req.file.originalname,
    });

    res.json({ success: true, ...result });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/knowledge/intake/url', async (req: Request, res: Response) => {
  const { url, role, category, subCategory, company, project, commodity, tags } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });

  try {
    const result = await knowledgeIntakeService.createUrlDraft({
      url,
      role: normalizeOptionalString(role) || undefined,
      category: normalizeOptionalString(category) || undefined,
      subCategory: normalizeOptionalString(subCategory) || undefined,
      company: normalizeOptionalString(company) || undefined,
      project: normalizeOptionalString(project) || undefined,
      commodity: normalizeOptionalString(commodity) || undefined,
      tags: parseTags(tags),
    });
    res.json({ success: true, ...result });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/knowledge/intake/:id/review', async (req: Request, res: Response) => {
  try {
    const record = await knowledgeIntakeService.reviewRecord(Number(req.params.id), {
      role: normalizeOptionalString(req.body.role) || undefined,
      category: normalizeOptionalString(req.body.category) || undefined,
      subCategory: normalizeOptionalString(req.body.subCategory) || undefined,
      company: normalizeOptionalString(req.body.company) || undefined,
      project: normalizeOptionalString(req.body.project) || undefined,
      commodity: normalizeOptionalString(req.body.commodity) || undefined,
      tags: parseTags(req.body.tags),
    });
    res.json({ success: true, record });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/knowledge/intake/:id/ingest', async (req: Request, res: Response) => {
  try {
    const record = await knowledgeIntakeService.ingestRecord(Number(req.params.id), {
      role: normalizeOptionalString(req.body.role) || undefined,
      category: normalizeOptionalString(req.body.category) || undefined,
      subCategory: normalizeOptionalString(req.body.subCategory) || undefined,
      company: normalizeOptionalString(req.body.company) || undefined,
      project: normalizeOptionalString(req.body.project) || undefined,
      commodity: normalizeOptionalString(req.body.commodity) || undefined,
      tags: parseTags(req.body.tags),
    });
    res.json({ success: true, record });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Search the knowledge base
app.post('/api/knowledge/search', async (req: Request, res: Response) => {
  const { query, limit, minSimilarity, role, category, subCategory, company, project, commodity, tags } = req.body;
  if (!query) return res.status(400).json({ error: 'Query is required' });

  try {
    let filters: KnowledgeFilters | null = {
      role: normalizeOptionalString(role) || undefined,
      category: normalizeOptionalString(category) || undefined,
      subCategory: normalizeOptionalString(subCategory) || undefined,
      company: normalizeOptionalString(company) || undefined,
      project: normalizeOptionalString(project) || undefined,
      commodity: normalizeOptionalString(commodity) || undefined,
      tags: parseTags(tags),
    };
    if (!filters.role && !filters.category && !filters.subCategory && !filters.company && !filters.project && !filters.commodity && (!filters.tags || filters.tags.length === 0)) {
      filters = await knowledgeIntakeService.inferFiltersFromPrompt(query);
    }

    const results = await vectorService.search(query, limit || 5, minSimilarity || 0.3, filters || {});
    res.json({ success: true, results, filters });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Ingest all files from KnowledgeDocs directory
app.post('/api/knowledge/ingest/dir', async (req: Request, res: Response) => {
  const { dirPath } = req.body;

  try {
    const results = await ingestionService.ingestDirectory(dirPath);
    const success = results.filter(r => r.status === 'success').length;
    const skipped = results.filter(r => r.status === 'skipped').length;
    const errors = results.filter(r => r.status === 'error').length;
    res.json({ success: true, results, summary: { success, skipped, errors } });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Ingest a single file
app.post('/api/knowledge/ingest/file', async (req: Request, res: Response) => {
  const { filePath } = req.body;
  if (!filePath) return res.status(400).json({ error: 'filePath is required' });

  try {
    const result = await ingestionService.ingestFile(filePath);
    res.json({ success: true, result });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Ingest a URL
app.post('/api/knowledge/ingest/url', async (req: Request, res: Response) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });

  try {
    const result = await ingestionService.ingestUrl(url);
    res.json({ success: true, result });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Ingest raw text
app.post('/api/knowledge/ingest/text', async (req: Request, res: Response) => {
  const { text, title, sourcePath } = req.body;
  if (!text || !title) return res.status(400).json({ error: 'text and title are required' });

  try {
    const result = await ingestionService.ingestText(text, title, sourcePath);
    res.json({ success: true, result });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete a document from knowledge base
app.delete('/api/knowledge/documents', async (req: Request, res: Response) => {
  const { sourcePath } = req.body;
  if (!sourcePath) return res.status(400).json({ error: 'sourcePath is required' });

  try {
    const deleted = await vectorService.deleteDocument(sourcePath);
    res.json({ success: true, deleted });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Model Configuration API Endpoints
 */

// Get full model config (cloud + local)
app.get('/api/models', (_req: Request, res: Response) => {
  res.json({ success: true, ...modelConfigService.getConfig() });
});

// Get the active chain (ordered, enabled only)
app.get('/api/models/chain', (_req: Request, res: Response) => {
  res.json({ success: true, chain: modelConfigService.getActiveChain() });
});

// Add or update a cloud model
app.post('/api/models/cloud', (req: Request, res: Response) => {
  try {
    modelConfigService.setCloudModel(req.body);
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Add or update a local model
app.post('/api/models/local', (req: Request, res: Response) => {
  try {
    modelConfigService.setLocalModel(req.body);
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Toggle model enabled/disabled
app.post('/api/models/toggle', (req: Request, res: Response) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'id is required' });
  const model = modelConfigService.toggleModel(id);
  if (!model) return res.status(404).json({ error: 'Model not found' });
  res.json({ success: true, model });
});

// Delete a model
app.delete('/api/models', (req: Request, res: Response) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'id is required' });
  const removed = modelConfigService.deleteModel(id);
  res.json({ success: removed });
});

// Reorder cloud models
app.post('/api/models/reorder/cloud', (req: Request, res: Response) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order array is required' });
  modelConfigService.reorderCloud(order);
  res.json({ success: true });
});

// Reorder local models
app.post('/api/models/reorder/local', (req: Request, res: Response) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order array is required' });
  modelConfigService.reorderLocal(order);
  res.json({ success: true });
});

// Set auto mode
app.post('/api/models/auto', (req: Request, res: Response) => {
  const { enabled } = req.body;
  modelConfigService.setAutoMode(!!enabled);
  res.json({ success: true, autoMode: !!enabled });
});

// Test a cloud model's API connection
app.post('/api/models/test', async (req: Request, res: Response) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'id is required' });
  const result = await modelConfigService.testCloudModel(id);
  res.json({ success: result.ok, ...result });
});

/**
 * Project Context API Endpoints
 */

// List all projects
app.get('/api/projects', async (_req: Request, res: Response) => {
  try {
    const projects = await projectContextService.listProjects();
    res.json({ success: true, projects });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Create a new project or node
app.post('/api/projects', async (req: Request, res: Response) => {
  try {
    const node = await projectContextService.createNode(req.body);
    res.json({ success: true, node });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get a specific node
app.get('/api/projects/:id', async (req: Request, res: Response) => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const node = await projectContextService.getNode(id);
    if (!node) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, node });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get children of a node
app.get('/api/projects/:id/children', async (req: Request, res: Response) => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const children = await projectContextService.getChildren(id);
    res.json({ success: true, children });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get full tree from a root
app.get('/api/projects/:id/tree', async (req: Request, res: Response) => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const tree = await projectContextService.getTree(id);
    res.json({ success: true, tree });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Update a node
app.put('/api/projects/:id', async (req: Request, res: Response) => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const node = await projectContextService.updateNode(id, req.body);
    if (!node) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, node });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete a node (cascades to children)
app.delete('/api/projects/:id', async (req: Request, res: Response) => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const deleted = await projectContextService.deleteNode(id);
    res.json({ success: deleted });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Search within a project
app.get('/api/projects/:id/search', async (req: Request, res: Response) => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const { q, limit } = req.query;
    const results = await projectContextService.searchWithinProject(
      id,
      (q as string) || '',
      limit ? parseInt(limit as string) : 5
    );
    res.json({ success: true, results });
  } catch (error: any) {
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

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(tag => normalizeOptionalString(tag)).filter((tag): tag is string => Boolean(tag));
  }
  if (typeof value === 'string' && value.trim()) {
    return value.split(',').map(tag => tag.trim()).filter(Boolean);
  }
  return [];
}
