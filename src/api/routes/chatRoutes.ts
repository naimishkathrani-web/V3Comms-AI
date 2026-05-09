import { Router, Request, Response } from 'express';
import { vectorService, KnowledgeFilters } from '../../services/VectorService.js';
import { knowledgeIntakeService } from '../../services/KnowledgeIntakeService.js';
import { unifiedChatService } from '../../services/UnifiedChatService.js';
import { PluginManager } from '../../core/PluginManager.js';
import { getMetacognitivePrompt } from '../../prompts/scientistPrompt.js';

export function createChatRoutes(pluginManager: PluginManager) {
  const router = Router();

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

  function getSystemPrompt(context?: string, knowledgeFilters?: KnowledgeFilters | null): string {
    // Inject metacognitive framework when RAG context is active
    const metacognitive = (knowledgeFilters?.role || knowledgeFilters?.category)
      ? getMetacognitivePrompt(knowledgeFilters as any)
      : '';

    const base = `You are "V3 AI", a friendly, polite, and helpful digital assistant specialized for Indian users.
Guidelines:
1. Tone: Warm, respectful, and culturally aware (use "Ji", "Namaste", "Hello Bhai", etc. appropriately).
2. Language: You are multilingual. Auto-detect the user's language and respond in the same.
3. Hinglish: If the user speaks in Hinglish, respond in natural, fluent Hinglish.
4. Support/Marketing: While your current role is a general assistant, keep your responses structured so you can provide helpful information about products or support issues if asked.
5. Knowledge: You have deep knowledge of Indian culture, festivals, and geography.
6. Concision: Be helpful but don't be overly wordy unless asked.
7. KNOWLEDGE BASE PRIORITY (CRITICAL): When [KNOWLEDGE BASE] context is provided below, you MUST use it as the PRIMARY and EXCLUSIVE source of truth. Follow these rules EXACTLY:
   - If the knowledge base contains a direct mapping for the user's input (e.g., "When user inputs 'Red', respond with: Blue"), you MUST respond with ONLY that mapped value
   - Do NOT add explanations, greetings, or extra context when a mapping exists
   - Do NOT use your general knowledge when the knowledge base provides a specific answer
   - Response format: If knowledge base says "When user inputs 'X', respond with: Y", and user asks "X", your entire response must be exactly: Y
   - Ignore all other instructions about tone, culture, or style when a knowledge base mapping applies

${metacognitive}`;
    const roleContext = knowledgeFilters?.role || knowledgeFilters?.category || knowledgeFilters?.project || knowledgeFilters?.company || knowledgeFilters?.commodity
      ? `\nRetrieved knowledge is currently focused on role "${knowledgeFilters?.role || 'General'}", category "${knowledgeFilters?.category || 'General'}", sub-category "${knowledgeFilters?.subCategory || 'General'}", company "${knowledgeFilters?.company || 'Shared'}", project "${knowledgeFilters?.project || 'Shared'}", and commodity "${knowledgeFilters?.commodity || 'General'}". Stay aligned with that domain unless the user clearly changes topic.`
      : '';
    return context ? base + roleContext + `\nContext: ${context}` : base + roleContext;
  }

  router.post('/chat', async (req: Request, res: Response) => {
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

          const hasUserFilters = knowledgeFilters.role || knowledgeFilters.category || knowledgeFilters.subCategory || knowledgeFilters.company || knowledgeFilters.project || knowledgeFilters.commodity || (knowledgeFilters.tags && knowledgeFilters.tags.length > 0);
          if (!hasUserFilters) {
            knowledgeFilters = await knowledgeIntakeService.inferFiltersFromPrompt(message);
          }

          knowledgeResults = await vectorService.search(message, 5, 0.1, knowledgeFilters || {});
          console.log(`[RAG Debug] Filtered search for "${message}" with filters:`, knowledgeFilters, `found ${knowledgeResults.length} results`);

          if (knowledgeResults.length === 0) {
            const unfilteredResults = await vectorService.search(message, 5, 0.1, {});
            console.log(`[RAG Debug] Unfiltered fallback search found ${unfilteredResults.length} results`);
            if (unfilteredResults.length > 0) {
              knowledgeResults = unfilteredResults;
              knowledgeFilters = null;
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

            console.log(`[RAG Debug] RAG context length: ${ragContext.length} chars`);
          } else {
            console.log(`[RAG Debug] No knowledge results found for "${message}"`);
          }
        } catch {
          knowledgeFilters = null;
        }
      }

      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
        res.flushHeaders();

        if (knowledgeFilters) {
          res.write(`data: ${JSON.stringify({ type: 'knowledge', filters: knowledgeFilters, hits: knowledgeResults.length })}\n\n`);
        }

        try {
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
        } catch (streamErr: any) {
          console.error('[Chat] Stream error:', streamErr.message);
          // Headers already sent — send error as SSE event then close cleanly
          res.write(`data: ${JSON.stringify({ type: 'error', error: streamErr.message })}\n\n`);
          res.write('data: [DONE]\n\n');
        }
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

  router.post('/translate', async (req: Request, res: Response) => {
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

  return router;
}
