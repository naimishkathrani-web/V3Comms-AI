import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { join, extname } from 'path';
import { vectorService } from './VectorService.js';
import { config } from '../config/index.js';

const KNOWLEDGE_DOCS_DIR = join(import.meta.dirname, '../../KnowledgeDocs');

interface IngestionResult {
  source: string;
  chunks: number;
  status: 'success' | 'skipped' | 'error';
  message?: string;
}

/**
 * IngestionService — reads local files and URLs, chunks text,
 * generates embeddings via Ollama, and stores in pgvector.
 */
export class IngestionService {

  /**
   * Ingest all files from the KnowledgeDocs directory.
   * Skips files that haven't changed since last ingestion (by file hash).
   */
  async ingestDirectory(dirPath?: string): Promise<IngestionResult[]> {
    const dir = dirPath || KNOWLEDGE_DOCS_DIR;
    const results: IngestionResult[] = [];

    if (!existsSync(dir)) {
      return [{ source: dir, chunks: 0, status: 'error', message: 'Directory does not exist' }];
    }

    const files = this.listFilesRecursive(dir);

    if (files.length === 0) {
      return [{ source: dir, chunks: 0, status: 'error', message: 'No supported files found' }];
    }

    console.log(`[IngestionService] Found ${files.length} files in ${dir}`);

    for (const filePath of files) {
      try {
        const result = await this.ingestFile(filePath);
        results.push(result);
      } catch (error: any) {
        results.push({
          source: filePath,
          chunks: 0,
          status: 'error',
          message: error.message,
        });
      }
    }

    return results;
  }

  /**
   * Ingest a single local file.
   */
  async ingestFile(filePath: string): Promise<IngestionResult> {
    const relativePath = filePath.replace(/\\/g, '/');

    // Read file content
    const content = readFileSync(filePath, 'utf-8');
    const fileHash = this.hashContent(content);

    // Skip if already ingested with same hash
    if (await vectorService.isDocumentIngested(relativePath, fileHash)) {
      return { source: relativePath, chunks: 0, status: 'skipped', message: 'Unchanged since last ingestion' };
    }

    // Chunk the text
    const chunks = this.chunkText(content);

    if (chunks.length === 0) {
      return { source: relativePath, chunks: 0, status: 'error', message: 'No text content to embed' };
    }

    // Store in pgvector
    const title = filePath.split(/[/\\]/).pop() || filePath;
    await vectorService.addDocument('file', relativePath, title, chunks, fileHash);

    return { source: relativePath, chunks: chunks.length, status: 'success' };
  }

  /**
   * Ingest content from a URL.
   * Fetches the page, extracts text, chunks, and embeds.
   */
  async ingestUrl(url: string): Promise<IngestionResult> {
    try {
      console.log(`[IngestionService] Fetching URL: ${url}`);

      const response = await fetch(url, {
        headers: { 'User-Agent': 'V3Comms-AI/1.0' },
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        return { source: url, chunks: 0, status: 'error', message: `HTTP ${response.status}` };
      }

      const html = await response.text();
      const text = this.extractTextFromHtml(html);

      if (!text.trim()) {
        return { source: url, chunks: 0, status: 'error', message: 'No text content extracted' };
      }

      const contentHash = this.hashContent(text);

      // Skip if already ingested with same hash
      if (await vectorService.isDocumentIngested(url, contentHash)) {
        return { source: url, chunks: 0, status: 'skipped', message: 'Unchanged since last ingestion' };
      }

      const chunks = this.chunkText(text);
      const title = this.extractTitleFromHtml(html) || url;

      await vectorService.addDocument('url', url, title, chunks, contentHash);

      return { source: url, chunks: chunks.length, status: 'success' };
    } catch (error: any) {
      return { source: url, chunks: 0, status: 'error', message: error.message };
    }
  }

  /**
   * Ingest raw text directly.
   */
  async ingestText(text: string, title: string, sourcePath?: string): Promise<IngestionResult> {
    const path = sourcePath || `text:${title}`;
    const contentHash = this.hashContent(text);

    if (await vectorService.isDocumentIngested(path, contentHash)) {
      return { source: path, chunks: 0, status: 'skipped', message: 'Unchanged' };
    }

    const chunks = this.chunkText(text);
    await vectorService.addDocument('text', path, title, chunks, contentHash);

    return { source: path, chunks: chunks.length, status: 'success' };
  }

  /**
   * Split text into overlapping chunks for embedding.
   * Uses ~500 character chunks with 100 character overlap.
   */
  private chunkText(text: string, chunkSize: number = 500, overlap: number = 100): string[] {
    // Normalize whitespace
    const normalized = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

    if (normalized.length <= chunkSize) {
      return [normalized];
    }

    const chunks: string[] = [];
    let start = 0;

    while (start < normalized.length) {
      let end = start + chunkSize;

      // Try to break at sentence/paragraph boundary
      if (end < normalized.length) {
        const searchRange = normalized.slice(end - 50, end + 50);
        const breakPoints = [
          searchRange.lastIndexOf('\n\n'),
          searchRange.lastIndexOf('. '),
          searchRange.lastIndexOf('! '),
          searchRange.lastIndexOf('? '),
          searchRange.lastIndexOf('\n'),
        ].filter(i => i >= 0);

        if (breakPoints.length > 0) {
          const bestBreak = Math.max(...breakPoints);
          end = end - 50 + bestBreak + (searchRange[bestBreak] === '\n' ? 1 : 1);
        }
      }

      const chunk = normalized.slice(start, end).trim();
      if (chunk.length > 20) { // Skip very small chunks
        chunks.push(chunk);
      }

      start = end - overlap;
      if (start >= normalized.length) break;
    }

    return chunks;
  }

  /**
   * Extract readable text from HTML.
   */
  private extractTextFromHtml(html: string): string {
    // Remove script and style tags
    let text = html.replace(/<script[\s\S]*?<\/script>/gi, '');
    text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
    text = text.replace(/<nav[\s\S]*?<\/nav>/gi, '');
    text = text.replace(/<footer[\s\S]*?<\/footer>/gi, '');

    // Convert block elements to newlines
    text = text.replace(/<\/?(p|div|h[1-6]|li|tr|br|hr)[^>]*>/gi, '\n');

    // Remove all remaining HTML tags
    text = text.replace(/<[^>]+>/g, ' ');

    // Decode HTML entities
    text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    text = text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');

    // Clean up whitespace
    text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

    return text;
  }

  /**
   * Extract page title from HTML.
   */
  private extractTitleFromHtml(html: string): string | null {
    const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return match ? match[1].trim() : null;
  }

  /**
   * List all supported files in a directory recursively.
   */
  private listFilesRecursive(dir: string): string[] {
    const supportedExtensions = new Set([
      '.txt', '.md', '.csv', '.json', '.yaml', '.yml',
      '.html', '.htm', '.xml', '.log',
      '.ts', '.js', '.tsx', '.jsx', '.py', '.java', '.c', '.cpp', '.h',
      '.css', '.scss', '.less',
      '.sql', '.sh', '.bat', '.ps1',
      '.env', '.gitignore', '.dockerignore',
      '.conf', '.ini', '.cfg',
    ]);

    const files: string[] = [];

    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip hidden dirs and node_modules
        if (!entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== 'dist') {
          files.push(...this.listFilesRecursive(fullPath));
        }
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (supportedExtensions.has(ext)) {
          files.push(fullPath);
        }
      }
    }

    return files;
  }

  /**
   * Hash content for change detection.
   */
  private hashContent(content: string): string {
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
  }
}

export const ingestionService = new IngestionService();
