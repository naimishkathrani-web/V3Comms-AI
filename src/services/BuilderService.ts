import { exec } from 'child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { ollamaService } from './OllamaService.js';
import { config } from '../config/index.js';

export interface BuilderTask {
  id: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  createdAt: number;
  result?: string;
}

const REPO_ROOT = join(import.meta.dirname, '../..');

// Builder starts from a smarter model in the fallback chain.
// If phi3.5 is too slow, it auto-falls back to mistral.
// Override with BUILDER_MODEL env var (e.g., gemma2:2b for faster, mistral:latest for best)
const BUILDER_MODEL = process.env.BUILDER_MODEL || 'phi3.5:latest';

const BUILDER_SYSTEM_PROMPT = `You are V3 Builder, an AI coding assistant. You modify code in a Node.js/TypeScript project.

You have these tools. To call a tool, write EXACTLY:
TOOL:tool_name {json arguments}

Tools:
- TOOL:read_file {"path":"src/api/server.ts"} — read a file
- TOOL:patch_file {"path":"public/index.html","search":"exact text to find","replace":"replacement text"} — find and replace text in a file
- TOOL:write_file {"path":"src/new.ts","content":"code"} — create a NEW file (use patch_file for existing files)
- TOOL:list_files {"path":"src"} — list directory contents
- TOOL:run_command {"command":"npx tsc --noEmit"} — run a shell command
- TOOL:delete_file {"path":"src/old.ts"} — delete a file

RULES:
- Always use TOOL:name {json} format — nothing else
- Always READ a file before modifying it
- Use patch_file for EXISTING files — it finds exact text and replaces it
- Use write_file only for creating NEW files
- After writing code, run TOOL:run_command {"command":"npx tsc --noEmit"}
- If build fails, read the error, fix it, and verify again
- Use RELATIVE paths from project root
- Keep responses brief
- Never modify node_modules or .env
- NEVER try to kill the server process or restart it

Example:
User: Add a Test button to index.html sidebar
Assistant:
TOOL:read_file {"path":"public/index.html"}
TOOL:patch_file {"path":"public/index.html","search":"<li data-section=\"docs\">","replace":"<li data-section=\"test\"><span class=\"icon\">🧪</span> Test</li>\n<li data-section=\"docs\">"}
TOOL:run_command {"command":"npx tsc --noEmit"}
Done!`;

export class BuilderService {
  private tasks: Map<string, BuilderTask> = new Map();
  private conversationHistory: { role: 'user' | 'assistant' | 'system'; content: string }[] = [];
  private maxHistoryTurns = 20;
  private contextInjected = false;

  constructor() {
    this.conversationHistory.push({ role: 'system', content: BUILDER_SYSTEM_PROMPT });
  }

  private resolvePath(relativePath: string): string {
    const resolved = join(REPO_ROOT, relativePath);
    if (!resolved.startsWith(REPO_ROOT)) {
      throw new Error('Path traversal not allowed');
    }
    return resolved;
  }

  private sanitizePath(pathStr: string): string {
    return pathStr.replace(/\.\./g, '').replace(/\\/g, '/');
  }

  /**
   * Build a quick project context string so the model knows the real file structure.
   */
  private buildProjectContext(): string {
    const topLevel = this.listFiles('.');
    return `Project file structure:\n${topLevel}\n\nTech stack: Node.js, TypeScript, Express, Ollama SDK, vanilla JS frontend.`;
  }

  private listFiles(dir: string): string {
    const absPath = this.resolvePath(dir);
    if (!existsSync(absPath)) return '(not found)';
    try {
      const entries = readdirSync(absPath, { withFileTypes: true });
      return entries
        .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'dist')
        .map(e => {
          if (e.isDirectory()) {
            return `📁 ${e.name}/`;
          }
          return `📄 ${e.name}`;
        })
        .join('\n');
    } catch {
      return '(error reading)';
    }
  }

  /**
   * Execute a tool call and return the result.
   */
  private executeTool(toolName: string, args: any): string {
    try {
      switch (toolName) {
        case 'read_file': {
          if (!args.path) return 'Error: path is required';
          const absPath = this.resolvePath(this.sanitizePath(args.path));
          if (!existsSync(absPath)) return `Error: File not found: ${args.path}`;
          const content = readFileSync(absPath, 'utf-8');
          return content.length > 50000
            ? content.slice(0, 50000) + '\n... [truncated]'
            : content;
        }

        case 'write_file': {
          if (!args.path || args.content === undefined) return 'Error: path and content are required';
          const absPath = this.resolvePath(this.sanitizePath(args.path));
          const dir = join(absPath, '..');
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          writeFileSync(absPath, args.content, 'utf-8');
          return `Successfully wrote ${args.content.length} chars to ${args.path}`;
        }

        case 'patch_file': {
          if (!args.path || !args.search || args.replace === undefined) {
            return 'Error: path, search, and replace are required';
          }
          const absPath = this.resolvePath(this.sanitizePath(args.path));
          if (!existsSync(absPath)) return `Error: File not found: ${args.path}`;
          const content = readFileSync(absPath, 'utf-8');
          if (!content.includes(args.search)) {
            // Try to find a close match
            const lines = content.split('\n');
            const searchLines = args.search.split('\n');
            let found = false;
            for (let i = 0; i <= lines.length - searchLines.length; i++) {
              const slice = lines.slice(i, i + searchLines.length).join('\n');
              if (slice.trim() === args.search.trim()) {
                // Found with whitespace difference — apply with original whitespace
                lines.splice(i, searchLines.length, ...args.replace.split('\n'));
                writeFileSync(absPath, lines.join('\n'), 'utf-8');
                return `Patched ${args.path} (whitespace-tolerant match at line ${i + 1})`;
              }
            }
            return `Error: Search text not found in ${args.path}. Try reading the file again and use exact text.`;
          }
          const newContent = content.replace(args.search, args.replace);
          writeFileSync(absPath, newContent, 'utf-8');
          return `Patched ${args.path}: replaced ${args.search.length} chars with ${args.replace.length} chars`;
        }

        case 'list_files': {
          const absPath = this.resolvePath(this.sanitizePath(args.path || '.'));
          if (!existsSync(absPath)) return `Error: Directory not found: ${args.path}`;
          const entries = readdirSync(absPath, { withFileTypes: true });
          const listing = entries
            .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'dist')
            .map(e => `${e.isDirectory() ? '📁' : '📄'} ${e.name}`)
            .join('\n');
          return listing || '(empty directory)';
        }

        case 'delete_file': {
          if (!args.path) return 'Error: path is required';
          const absPath = this.resolvePath(this.sanitizePath(args.path));
          if (!existsSync(absPath)) return `Error: File not found: ${args.path}`;
          unlinkSync(absPath);
          return `Deleted ${args.path}`;
        }

        case 'run_command': {
          // Handled in chat loop via runCommandAsync
          return '[async execution required — handled in chat loop]';
        }

        default:
          return `Error: Unknown tool "${toolName}". Available tools: read_file, write_file, list_files, run_command, delete_file`;
      }
    } catch (error: any) {
      return `Error executing ${toolName}: ${error.message}`;
    }
  }

  /**
   * Run a shell command asynchronously with a timeout.
   */
  private runCommandAsync(command: string): Promise<string> {
    // Block commands that could kill the server itself
    const blocked = ['taskkill', 'Stop-Process', 'kill ', 'pkill', 'shutdown'];
    const cmdLower = command.toLowerCase();
    for (const b of blocked) {
      if (cmdLower.includes(b.toLowerCase())) {
        // Allow killing OTHER processes on port 3000, but not the current PID
        if (cmdLower.includes('3000') || cmdLower.includes('node.exe')) {
          return Promise.resolve(`Blocked: Cannot kill node processes (would kill the server). Use a separate terminal to restart.`);
        }
      }
    }

    return new Promise((resolve) => {
      const timeout = 60000; // 60s for builds
      exec(command, { cwd: REPO_ROOT, timeout, shell: 'powershell.exe' }, (error, stdout, stderr) => {
        let output = '';
        if (stdout) output += stdout;
        if (stderr) output += (output ? '\n' : '') + stderr;
        if (error && !stdout && !stderr) output = `Command failed: ${error.message}`;
        if (output.length > 10000) output = output.slice(0, 10000) + '\n... [truncated]';
        resolve(output || '(no output)');
      });
    });
  }

  /**
   * Parse tool calls from model output.
   * Supports multiple formats since small models are inconsistent:
   *   TOOL:name {json}
   *   [TOOL:name]{json}
   *   <<TOOL:name>>json<</TOOL>>
   */
  private parseToolCalls(text: string): Array<{ toolName: string; args: any; raw: string }> {
    const calls: Array<{ toolName: string; args: any; raw: string }> = [];
    const validTools = new Set(['read_file', 'write_file', 'patch_file', 'list_files', 'run_command', 'delete_file']);

    // Find all tool call candidates using a prefix regex, then extract balanced JSON
    const toolPrefixes = [
      /TOOL:(\w+)\s*/g,       // Format: TOOL:name {json}
      /\[TOOL:(\w+)\]\s*/g,   // Format: [TOOL:name]{json}
    ];

    for (const prefixRegex of toolPrefixes) {
      let prefixMatch;
      while ((prefixMatch = prefixRegex.exec(text)) !== null) {
        const toolName = prefixMatch[1];
        if (!validTools.has(toolName)) continue;

        // Extract balanced JSON starting from the position after the prefix
        const jsonStart = prefixMatch.index + prefixMatch[0].length;
        const jsonStr = text.slice(jsonStart);
        const extracted = this.extractBalancedJson(jsonStr);

        if (extracted) {
          try {
            const args = JSON.parse(extracted.json);
            calls.push({ toolName, args, raw: text.slice(prefixMatch.index, jsonStart + extracted.endIndex) });
          } catch {
            // Try fixing common JSON issues
            const fixed = extracted.json.replace(/'/g, '"');
            try {
              calls.push({ toolName, args: JSON.parse(fixed), raw: text.slice(prefixMatch.index, jsonStart + extracted.endIndex) });
            } catch {
              calls.push({ toolName, args: { _raw: extracted.json }, raw: text.slice(prefixMatch.index, jsonStart + extracted.endIndex) });
            }
          }
        }
      }
      if (calls.length > 0) break; // Use first format that matches
    }

    // Format 3: <<TOOL:name>>json<</TOOL>> (only if no other format matched)
    if (calls.length === 0) {
      const fmt3 = /<<TOOL:(\w+)>>([\s\S]*?)<<\/TOOL>>/g;
      let match;
      while ((match = fmt3.exec(text)) !== null) {
        const toolName = match[1];
        if (!validTools.has(toolName)) continue;
        const argsStr = match[2].trim();
        try {
          calls.push({ toolName, args: JSON.parse(argsStr), raw: match[0] });
        } catch {
          calls.push({ toolName, args: { _raw: argsStr }, raw: match[0] });
        }
      }
    }

    return calls;
  }

  /**
   * Extract balanced JSON from a string starting with '{'.
   * Handles nested braces and string escaping.
   */
  private extractBalancedJson(text: string): { json: string; endIndex: number } | null {
    if (!text.startsWith('{')) return null;

    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];

      if (escape) {
        escape = false;
        continue;
      }

      if (ch === '\\' && inString) {
        escape = true;
        continue;
      }

      if (ch === '"') {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          return { json: text.slice(0, i + 1), endIndex: i + 1 };
        }
      }
    }

    return null;
  }

  /**
   * Main chat loop with tool use.
   * Max 8 tool-use rounds to allow multi-step builds.
   */
  async *chatStream(userMessage: string): AsyncGenerator<string> {
    // Inject project context on first message
    if (!this.contextInjected) {
      this.contextInjected = true;
      const context = this.buildProjectContext();
      this.conversationHistory.push({
        role: 'user',
        content: `[SYSTEM CONTEXT — this is the real project structure, trust this over any assumptions]:\n${context}`,
      });
      this.conversationHistory.push({
        role: 'assistant',
        content: 'Understood. I will use the actual project structure shown above for all operations.',
      });
    }

    // Add user message to history
    this.conversationHistory.push({ role: 'user', content: userMessage });

    // Trim history if too long
    if (this.conversationHistory.length > this.maxHistoryTurns * 2 + 1) {
      const systemMsg = this.conversationHistory[0];
      this.conversationHistory = [
        systemMsg,
        ...this.conversationHistory.slice(-this.maxHistoryTurns * 2),
      ];
    }

    const maxRounds = 8;

    for (let round = 0; round < maxRounds; round++) {
      // Get model response — use builder-specific model (not fallback chain)
      let fullResponse = '';

      // Use the builder model directly for better instruction-following
      const stream = ollamaService.chatStreamWithFallback(
        this.conversationHistory,
        { model: BUILDER_MODEL }
      );

      for await (const chunk of stream) {
        if (chunk.startsWith('[META:')) {
          yield chunk;
        } else {
          fullResponse += chunk;
          yield chunk;
        }
      }

      // Save assistant response to history
      this.conversationHistory.push({ role: 'assistant', content: fullResponse });

      // Check for tool calls
      const toolCalls = this.parseToolCalls(fullResponse);

      if (toolCalls.length === 0) {
        return;
      }

      // Execute tools and collect results
      const toolResults: string[] = [];
      for (const call of toolCalls) {
        yield `\n[EXECUTING: ${call.toolName}]\n`;

        let result: string;
        if (call.toolName === 'run_command') {
          const cmd = call.args.command || call.args._raw || '';
          if (!cmd) {
            result = 'Error: command is required for run_command';
          } else {
            result = await this.runCommandAsync(cmd);
          }
        } else {
          result = this.executeTool(call.toolName, call.args);
        }

        toolResults.push(`[Result of ${call.toolName}]: ${result}`);
        yield `[TOOL_RESULT:${call.toolName}]${result}\n`;
      }

      // Feed tool results back
      const resultsMessage = toolResults.join('\n\n');
      this.conversationHistory.push({
        role: 'user',
        content: `Tool results:\n\n${resultsMessage}\n\nIf the task is done, say "Done!" and summarize. If there are errors, fix them with more tool calls. If build passed, you're done.`,
      });
    }

    yield '\n[Max tool-use rounds reached. Send another message to continue.]';
  }

  getTasks(): BuilderTask[] {
    return Array.from(this.tasks.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  resetConversation(): void {
    this.conversationHistory = [{ role: 'system', content: BUILDER_SYSTEM_PROMPT }];
    this.contextInjected = false;
  }

  getFileTree(dir: string = '.', depth: number = 0, maxDepth: number = 3): any[] {
    if (depth > maxDepth) return [];
    const absPath = this.resolvePath(dir);
    if (!existsSync(absPath)) return [];

    try {
      const entries = readdirSync(absPath, { withFileTypes: true });
      return entries
        .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'dist')
        .map(e => {
          const relPath = join(dir, e.name).replace(/\\/g, '/');
          if (e.isDirectory()) {
            return {
              name: e.name,
              path: relPath,
              type: 'directory',
              children: this.getFileTree(relPath, depth + 1, maxDepth),
            };
          }
          return {
            name: e.name,
            path: relPath,
            type: 'file',
            size: statSync(join(absPath, e.name)).size,
          };
        });
    } catch {
      return [];
    }
  }
}

export const builderService = new BuilderService();
