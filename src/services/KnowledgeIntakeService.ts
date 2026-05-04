import { mkdirSync, writeFileSync } from 'fs';
import { basename, extname, join } from 'path';
import { createHash } from 'crypto';
import { ollamaService } from './OllamaService.js';
import { vectorService, KnowledgeIntakeRecord, KnowledgeFilters } from './VectorService.js';
import { config } from '../config/index.js';

const KNOWLEDGE_DOCS_DIR = join(import.meta.dirname, '../../KnowledgeDocs');

export interface KnowledgeClassification {
  role: string | null;
  category: string | null;
  subCategory: string | null;
  company: string | null;
  project: string | null;
  commodity: string | null;
  tags: string[];
  summary: string;
  confidence: number;
  reasoning: string;
  conceptName: string | null;
  definition: string | null;
  reasoningTrap: string | null;
}

export interface IntakeDraftInput {
  sourceType: 'file' | 'url' | 'text';
  title: string;
  content: string;
  sourcePath?: string;
  sourceUrl?: string;
  role?: string;
  category?: string;
  subCategory?: string;
  company?: string;
  project?: string;
  commodity?: string;
  tags?: string[];
  originalFileName?: string;
}

export interface IntakeDraftResult {
  record: KnowledgeIntakeRecord;
  classification: KnowledgeClassification;
  warnings: string[];
}

const DEFAULT_ROLES = [
  'Stock Trader',
  'Enterprise Architect',
  'Siebel Developer',
  'Support Agent',
  'Marketing Specialist',
  'Project Manager',
  'General Knowledge',
];

const DEFAULT_CATEGORIES = [
  'Architecture',
  'Trading',
  'CRM',
  'Integration',
  'Operations',
  'Product',
  'Support',
  'Reference',
  'General',
];

const DEFAULT_SUB_CATEGORIES = [
  'Market Research',
  'Technical Analysis',
  'Fundamental Analysis',
  'Risk Management',
  'Trading Strategy',
  'Project Notes',
  'Company Research',
  'General',
];

export class KnowledgeIntakeService {
  getDefaultTaxonomy() {
    return {
      roles: DEFAULT_ROLES,
      categories: DEFAULT_CATEGORIES,
      subCategories: DEFAULT_SUB_CATEGORIES,
      companies: [],
      projects: [],
      commodities: [],
    };
  }

  async getTaxonomy() {
    const existing = await vectorService.getKnowledgeTaxonomy();
    return {
      roles: Array.from(new Set([...DEFAULT_ROLES, ...existing.roles])).sort(),
      categories: Array.from(new Set([...DEFAULT_CATEGORIES, ...existing.categories])).sort(),
      subCategories: Array.from(new Set([...DEFAULT_SUB_CATEGORIES, ...existing.subCategories])).sort(),
      companies: existing.companies,
      projects: existing.projects,
      commodities: existing.commodities,
    };
  }

  async classifyContent(content: string, title?: string, sourceUrl?: string): Promise<KnowledgeClassification> {
    const sample = content.slice(0, 5000);
    const prompt = `Analyze this knowledge document and classify it.

Return valid JSON only with this exact shape:
{
  "role": string|null,
  "category": string|null,
  "subCategory": string|null,
  "company": string|null,
  "project": string|null,
  "commodity": string|null,
  "tags": string[],
  "summary": string,
  "confidence": number,
  "reasoning": string,
  "conceptName": string|null,
  "definition": string|null,
  "reasoningTrap": string|null
}

Rules for 'Psychologist' Mindset extraction:
- "conceptName": The core psychological or technical principle discussed (e.g., "Cognitive Dissonance").
- "definition": A concise first-principles definition of the concept.
- "reasoningTrap": Common logical fallacies or cognitive biases related to this concept that a researcher should avoid.

Rules:
- "role" should be the most relevant audience or persona for this content, such as "Stock Trader", "Enterprise Architect", "Siebel Developer", or "General Knowledge".
- "category" should be a short domain label, such as "Trading", "Architecture", "CRM", "Integration", "Support", or "General".
- "subCategory" should be a more precise grouping such as "Technical Analysis", "Trading Strategy", "Market Research", "Project Notes", or "General".
- "company" should be set only if the content is clearly company-specific.
- "project" should be set only if the content is clearly project-specific.
- "commodity" should be set only if the content is about a specific commodity such as Gold or Crude Oil.
- "tags" should contain 1 to 5 concise tags.
- "summary" should be one short sentence.
- "confidence" must be between 0 and 1.
- If unclear, prefer "General Knowledge" and "General".

Title: ${title || 'Untitled'}
Source URL: ${sourceUrl || 'N/A'}

Content:
${sample}`;

    try {
      const result = await ollamaService.chatWithFallback([
        {
          role: 'system',
          content: 'You classify business and technical documents. Output JSON only with no markdown.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ], { model: config.ollama.model });

      const parsed = this.parseJson<Partial<KnowledgeClassification>>(result.content);
      return {
        role: this.cleanValue(parsed.role) || 'General Knowledge',
        category: this.cleanValue(parsed.category) || 'General',
        subCategory: this.cleanValue((parsed as any).subCategory) || 'General',
        company: this.cleanValue((parsed as any).company),
        project: this.cleanValue((parsed as any).project),
        commodity: this.cleanValue((parsed as any).commodity),
        tags: this.normalizeTags(parsed.tags),
        summary: this.cleanValue(parsed.summary) || 'Document prepared for knowledge ingestion.',
        confidence: this.normalizeConfidence(parsed.confidence),
        reasoning: this.cleanValue(parsed.reasoning) || 'Classification inferred from the document content.',
        conceptName: this.cleanValue(parsed.conceptName),
        definition: this.cleanValue(parsed.definition),
        reasoningTrap: this.cleanValue(parsed.reasoningTrap),
      };
    } catch {
      return {
        role: 'General Knowledge',
        category: 'General',
        subCategory: 'General',
        company: null,
        project: null,
        commodity: null,
        tags: [],
        summary: 'Document prepared for knowledge ingestion.',
        confidence: 0.2,
        reasoning: 'Automatic classification fallback was used.',
        conceptName: null,
        definition: null,
        reasoningTrap: null,
      };
    }
  }

  async inferFiltersFromPrompt(message: string): Promise<KnowledgeFilters | null> {
    if (!message.trim()) return null;
    const classification = await this.classifyContent(message, 'User question');
    if (classification.confidence < 0.45) return null;

    return {
      role: classification.role || undefined,
      category: classification.category || undefined,
      subCategory: classification.subCategory || undefined,
      company: classification.company || undefined,
      project: classification.project || undefined,
      commodity: classification.commodity || undefined,
      tags: classification.tags,
    };
  }

  async createDraft(input: IntakeDraftInput): Promise<IntakeDraftResult> {
    const classification = await this.classifyContent(input.content, input.title, input.sourceUrl);
    const finalRole = this.cleanValue(input.role) || classification.role || 'General Knowledge';
    const finalCategory = this.cleanValue(input.category) || classification.category || 'General';
    const finalSubCategory = this.cleanValue(input.subCategory) || classification.subCategory || 'General';
    const finalCompany = this.cleanValue(input.company) || classification.company;
    const finalProject = this.cleanValue(input.project) || classification.project;
    const finalCommodity = this.cleanValue(input.commodity) || classification.commodity;
    const finalTags = this.normalizeTags(input.tags?.length ? input.tags : classification.tags);
    const warnings = this.buildWarnings(input, classification);

    const targetPath = input.sourceType === 'url'
      ? input.sourceUrl || input.sourcePath || `url:${input.title}`
      : this.resolveFilePath({
          role: finalRole,
          category: finalCategory,
          subCategory: finalSubCategory,
          company: finalCompany,
          project: finalProject,
          commodity: finalCommodity,
          originalName: input.originalFileName || input.title,
          fallbackExtension: extname(input.originalFileName || input.title) || '.txt',
        });

    if (input.sourceType !== 'url') {
      mkdirSync(join(KNOWLEDGE_DOCS_DIR, this.slugify(finalRole)), { recursive: true });
      writeFileSync(targetPath, input.content, 'utf-8');
    }

    const record = await vectorService.createKnowledgeIntakeRecord({
      sourceType: input.sourceType,
      sourcePath: targetPath.replace(/\\/g, '/'),
      sourceUrl: input.sourceUrl || null,
      title: input.title,
      status: 'review_required',
      role: finalRole,
      category: finalCategory,
      subCategory: finalSubCategory,
      company: finalCompany,
      project: finalProject,
      commodity: finalCommodity,
      tags: finalTags,
      suggestedRole: classification.role,
      suggestedCategory: classification.category,
      suggestedSubCategory: classification.subCategory,
      suggestedCompany: classification.company,
      suggestedProject: classification.project,
      suggestedCommodity: classification.commodity,
      suggestedTags: classification.tags,
      suggestedConceptName: classification.conceptName,
      suggestedDefinition: classification.definition,
      suggestedReasoningTrap: classification.reasoningTrap,
      classificationConfidence: classification.confidence,
      classificationReasoning: classification.reasoning,
      contentHash: this.hashContent(input.content),
      contentPreview: input.content.slice(0, 1500),
      sourceMetadata: {
        summary: classification.summary,
        originalFileName: input.originalFileName || null,
        warnings,
      },
    });

    return { record, classification, warnings };
  }

  async createUrlDraft(input: {
    url: string;
    role?: string;
    category?: string;
    subCategory?: string;
    company?: string;
    project?: string;
    commodity?: string;
    tags?: string[];
  }): Promise<IntakeDraftResult> {
    try {
      const response = await fetch(input.url, {
        headers: { 'User-Agent': 'V3Comms-AI/1.0' },
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) {
        throw new Error(`Failed to fetch URL: HTTP ${response.status}`);
      }

      const html = await response.text();
      const content = this.extractTextFromHtml(html);
      if (!content.trim()) {
        throw new Error('No readable text content found at the provided URL');
      }

      const title = this.extractTitleFromHtml(html) || input.url;
      return this.createDraft({
        sourceType: 'url',
        title,
        content,
        sourceUrl: input.url,
        sourcePath: input.url,
        role: input.role,
        category: input.category,
        subCategory: input.subCategory,
        company: input.company,
        project: input.project,
        commodity: input.commodity,
        tags: input.tags,
      });
    } catch (error: any) {
      console.error(`[KnowledgeIntakeService] URL intake failed: ${error.message}`);
      throw error;
    }
  }

  async reviewRecord(id: number, updates: { role?: string; category?: string; subCategory?: string; company?: string; project?: string; commodity?: string; tags?: string[] }) {
    const record = await vectorService.getKnowledgeIntakeRecord(id);
    if (!record) throw new Error('Knowledge intake record not found');
    if (record.read_only) throw new Error('This knowledge record is read-only after ingestion');
    return vectorService.updateKnowledgeIntakeRecord(id, 'ready_to_ingest', {
      role: updates.role,
      category: updates.category,
      sub_category: updates.subCategory,
      company: updates.company,
      project: updates.project,
      commodity: updates.commodity,
      tags: updates.tags,
    });
  }

  async ingestRecord(id: number, override?: { role?: string; category?: string; subCategory?: string; company?: string; project?: string; commodity?: string; tags?: string[] }) {
    const record = await vectorService.getKnowledgeIntakeRecord(id);
    if (!record) throw new Error('Knowledge intake record not found');
    if (record.read_only) throw new Error('This knowledge record is read-only after ingestion');

    // Mark as in-progress immediately
    await vectorService.updateKnowledgeIntakeStatus(id, 'in_progress');

    try {
      const content = record.content_preview || this.fetchContentForRecord(record);
      if (!content.trim()) throw new Error('No content available to ingest');

      const role = this.cleanValue(override?.role) || record.role || record.suggested_role || 'General Knowledge';
      const category = this.cleanValue(override?.category) || record.category || record.suggested_category || 'General';
      const subCategory = this.cleanValue(override?.subCategory) || record.sub_category || record.suggested_sub_category || 'General';
      const company = this.cleanValue(override?.company) || record.company || record.suggested_company;
      const project = this.cleanValue(override?.project) || record.project || record.suggested_project;
      const commodity = this.cleanValue(override?.commodity) || record.commodity || record.suggested_commodity;
      const tags = this.normalizeTags(override?.tags?.length ? override.tags : record.tags || record.suggested_tags || []);

      const chunks = this.chunkText(content);
      if (chunks.length === 0) throw new Error('No text content to embed');

      const metadata = {
        role,
        category,
        sub_category: subCategory,
        company,
        project,
        commodity,
        tags,
        intakeRecordId: record.id,
        title: record.title,
        sourceType: record.source_type,
        sourceUrl: record.source_url,
      };

      await vectorService.addDocument(
        record.source_type,
        record.source_path,
        record.title,
        chunks,
        record.content_hash || undefined,
        metadata,
        record.id,
      );

      const updated = await vectorService.markKnowledgeIntakeRecordIngested(record.id, {
        role,
        category,
        subCategory,
        company,
        project,
        commodity,
        tags,
        chunkCount: chunks.length,
        embeddingModel: config.embeddingModel,
      });

      return updated;
    } catch (error: any) {
      console.error(`[KnowledgeIntakeService] Ingestion failed for record ${id}: ${error.message}`);
      // Mark record with error status and save reason
      await vectorService.updateKnowledgeIntakeStatus(id, 'error', error.message);
      throw error;
    }
  }

  private fetchContentForRecord(record: KnowledgeIntakeRecord): string {
    return record.content_preview || '';
  }

  private buildWarnings(input: IntakeDraftInput, classification: KnowledgeClassification): string[] {
    const warnings: string[] = [];
    if (input.role && classification.role && input.role.trim().toLowerCase() !== classification.role.trim().toLowerCase()) {
      warnings.push(`Selected role "${input.role}" differs from AI suggestion "${classification.role}".`);
    }
    if (input.category && classification.category && input.category.trim().toLowerCase() !== classification.category.trim().toLowerCase()) {
      warnings.push(`Selected category "${input.category}" differs from AI suggestion "${classification.category}".`);
    }
    if (input.subCategory && classification.subCategory && input.subCategory.trim().toLowerCase() !== classification.subCategory.trim().toLowerCase()) {
      warnings.push(`Selected sub-category "${input.subCategory}" differs from AI suggestion "${classification.subCategory}".`);
    }
    if (!input.role || !input.category) {
      warnings.push('Review the AI recommendations before pushing this document into RAG.');
    }
    return warnings;
  }

  private resolveFilePath(input: {
    role: string;
    category: string;
    subCategory: string;
    company?: string | null;
    project?: string | null;
    commodity?: string | null;
    originalName: string;
    fallbackExtension: string;
  }): string {
    const parts = [KNOWLEDGE_DOCS_DIR];
    if (input.company) {
      parts.push('companies', this.slugify(input.company));
    }
    if (input.project) {
      parts.push('projects', this.slugify(input.project));
    }
    if (input.commodity) {
      parts.push('commodities', this.slugify(input.commodity));
    }
    parts.push(this.slugify(input.role), this.slugify(input.category), this.slugify(input.subCategory));
    const roleDir = join(...parts);
    mkdirSync(roleDir, { recursive: true });
    const safeBase = this.slugify(basename(input.originalName, extname(input.originalName)) || 'knowledge-doc');
    const safeExt = extname(input.originalName) || input.fallbackExtension;
    return join(roleDir, `${safeBase}${safeExt}`);
  }

  private slugify(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'general';
  }

  private normalizeTags(tags: unknown): string[] {
    if (!Array.isArray(tags)) return [];
    return tags
      .map(tag => this.cleanValue(tag))
      .filter((tag): tag is string => Boolean(tag))
      .slice(0, 8);
  }

  private cleanValue(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private normalizeConfidence(value: unknown): number {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (Number.isNaN(parsed)) return 0.3;
    return Math.min(1, Math.max(0, parsed));
  }

  private parseJson<T>(raw: string): T {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON payload returned');
    return JSON.parse(match[0]) as T;
  }

  private hashContent(content: string): string {
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
  }

  private chunkText(text: string, chunkSize: number = 800, overlap: number = 150): string[] {
    const separators = ['\n\n\n', '\n\n', '\n', '. ', '! ', '? ', ' ', ''];
    return this.recursiveSplit(text.trim(), chunkSize, overlap, separators, '');
  }

  private recursiveSplit(text: string, chunkSize: number, overlap: number, separators: string[], currentHeader: string): string[] {
    const finalChunks: string[] = [];
    
    // Check if this block starts with a header
    const headerMatch = text.match(/^(#+)\s+(.+)$|^\n+(#+)\s+(.+)$|/m);
    let activeHeader = currentHeader;
    
    if (text.length <= chunkSize) {
      return [activeHeader ? `[Section: ${activeHeader}]\n${text}` : text];
    }

    // Find the best separator to use
    let separator = separators[separators.length - 1];
    let newSeparators: string[] = [];

    for (let i = 0; i < separators.length; i++) {
      if (text.includes(separators[i])) {
        separator = separators[i];
        newSeparators = separators.slice(i + 1);
        break;
      }
    }

    const splits = text.split(separator);
    let currentChunk = '';

    for (const split of splits) {
      // Check if the split itself contains a header
      const innerHeaderMatch = split.match(/^#+\s+(.+)$/m);
      if (innerHeaderMatch) {
        activeHeader = innerHeaderMatch[1].trim();
      }

      const chunkPrefix = (activeHeader && !currentChunk.includes(`[Section: ${activeHeader}]`)) 
        ? `[Section: ${activeHeader}]\n` 
        : '';
        
      if (currentChunk.length + split.length + separator.length + chunkPrefix.length <= chunkSize) {
        currentChunk += (currentChunk ? separator : '') + split;
      } else {
        if (currentChunk) {
          finalChunks.push(currentChunk.trim());
        }

        if (split.length > chunkSize) {
          const subChunks = this.recursiveSplit(split, chunkSize, overlap, newSeparators, activeHeader);
          finalChunks.push(...subChunks.slice(0, -1));
          currentChunk = subChunks[subChunks.length - 1];
        } else {
          currentChunk = split;
        }
      }
    }

    if (currentChunk) {
      finalChunks.push(currentChunk.trim());
    }

    return finalChunks.filter(c => c.length > 10).map(c => {
        // Ensure every chunk has the context if it was in a headered section
        if (activeHeader && !c.includes(`[Section: ${activeHeader}]`)) {
            return `[Section: ${activeHeader}]\n${c}`;
        }
        return c;
    });
  }

  private extractTextFromHtml(html: string): string {
    let text = html.replace(/<script[\s\S]*?<\/script>/gi, '');
    text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
    text = text.replace(/<nav[\s\S]*?<\/nav>/gi, '');
    text = text.replace(/<footer[\s\S]*?<\/footer>/gi, '');

    // Tag headers before stripping
    text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n\n\n# $1\n\n');
    text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n\n## $1\n\n');
    text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n\n### $1\n\n');
    
    text = text.replace(/<\/?(p|div|li|tr|br|hr|section|article)[^>]*>/gi, '\n');
    text = text.replace(/<[^>]+>/g, ' ');
    text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    text = text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
    
    return text.replace(/[ \t]+/g, ' ').replace(/\n{4,}/g, '\n\n\n').replace(/\n{3}/g, '\n\n\n').trim();
  }

  private extractTitleFromHtml(html: string): string | null {
    const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return match ? match[1].trim() : null;
  }
}

export const knowledgeIntakeService = new KnowledgeIntakeService();
