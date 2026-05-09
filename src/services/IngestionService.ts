import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { join, extname } from 'path';
import { vectorService } from './VectorService.js';
import { chunkingService } from './ChunkingService.js';
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
    const chunks = chunkingService.chunkText(content);

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
      const text = chunkingService.extractTextFromHtml(html);

      if (!text.trim()) {
        return { source: url, chunks: 0, status: 'error', message: 'No text content extracted' };
      }

      const contentHash = this.hashContent(text);

      // Skip if already ingested with same hash
      if (await vectorService.isDocumentIngested(url, contentHash)) {
        return { source: url, chunks: 0, status: 'skipped', message: 'Unchanged since last ingestion' };
      }

      const chunks = chunkingService.chunkText(text);
      const title = chunkingService.extractTitleFromHtml(html) || url;

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

    const chunks = chunkingService.chunkText(text);
    await vectorService.addDocument('text', path, title, chunks, contentHash);

    return { source: path, chunks: chunks.length, status: 'success' };
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
