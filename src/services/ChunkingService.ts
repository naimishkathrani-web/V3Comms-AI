/**
 * ChunkingService — unified text chunking for both IngestionService and KnowledgeIntakeService.
 * Uses recursive splitting with header tracking for better context preservation.
 */

export interface ChunkingOptions {
  chunkSize?: number;     // Target chunk size in characters (default: 800)
  overlap?: number;       // Overlap between chunks in characters (default: 150)
  minChunkSize?: number;  // Discard chunks smaller than this (default: 20)
  trackHeaders?: boolean; // Prefix chunks with [Section: header] (default: true)
}

const DEFAULT_OPTIONS: Required<ChunkingOptions> = {
  chunkSize: 800,
  overlap: 150,
  minChunkSize: 20,
  trackHeaders: true,
};

export class ChunkingService {
  /**
   * Split text into overlapping chunks using recursive splitting.
   * Respects paragraph/sentence boundaries and tracks markdown headers.
   */
  chunkText(text: string, options: ChunkingOptions = {}): string[] {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const normalized = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!normalized) return [];
    if (normalized.length <= opts.chunkSize) return [normalized];

    const separators = ['\n\n\n', '\n\n', '\n', '. ', '! ', '? ', ' ', ''];
    return this.recursiveSplit(normalized, opts.chunkSize, opts.overlap, separators, '', opts);
  }

  private recursiveSplit(
    text: string,
    chunkSize: number,
    overlap: number,
    separators: string[],
    currentHeader: string,
    opts: Required<ChunkingOptions>,
  ): string[] {
    const finalChunks: string[] = [];

    // Check if this block starts with a header
    const headerMatch = text.match(/^(#+)\s+(.+)$|^\n+(#+)\s+(.+)$|/m);
    let activeHeader = currentHeader;

    if (text.length <= chunkSize) {
      if (opts.trackHeaders && activeHeader && !text.includes(`[Section: ${activeHeader}]`)) {
        return [`[Section: ${activeHeader}]\n${text}`];
      }
      return [text];
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

      const chunkPrefix = (opts.trackHeaders && activeHeader && !currentChunk.includes(`[Section: ${activeHeader}]`))
        ? `[Section: ${activeHeader}]\n`
        : '';

      if (currentChunk.length + split.length + separator.length + chunkPrefix.length <= chunkSize) {
        currentChunk += (currentChunk ? separator : '') + split;
      } else {
        if (currentChunk) {
          finalChunks.push(currentChunk.trim());
        }

        if (split.length > chunkSize) {
          const subChunks = this.recursiveSplit(split, chunkSize, overlap, newSeparators, activeHeader, opts);
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

    return finalChunks
      .filter(c => c.length > opts.minChunkSize)
      .map(c => {
        if (opts.trackHeaders && activeHeader && !c.includes(`[Section: ${activeHeader}]`)) {
          return `[Section: ${activeHeader}]\n${c}`;
        }
        return c;
      });
  }

  /**
   * Extract readable text from HTML, preserving header structure.
   */
  extractTextFromHtml(html: string): string {
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

  /**
   * Extract page title from HTML.
   */
  extractTitleFromHtml(html: string): string | null {
    const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return match ? match[1].trim() : null;
  }
}

export const chunkingService = new ChunkingService();
