import { exec } from 'child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, unlinkSync } from 'fs';
import { join, relative } from 'path';
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

const BUILDER_SYSTEM_PROMPT = `You are "V3 Builder", an AI coding assistant embedded in the V3Comms-AI dashboard. You can read, write, and modify files in the project, run terminal commands, and manage build tasks.

AVAILABLE TOOLS — use these by outputting exactly the format shown:

1. Read a file:
   [TOOL:read_file]{"path":"relative/path/to/file"}

2. Write/create a file:
   [TOOL:write_file]{"path":"relative/path/to/file","content":"file contents here"}

3. List files in a directory:
   [TOOL:list_files]{"path":"relative/path/to/dir"}

4. Delete a file:
   [TOOL:delete_file]{"path":"relative/path/to/file"}

5. Run a terminal command:
   [TOOL:run_command]{"command":"the shell command"}

6. Create a build task:
   [TOOL:create_task]{"description":"what to build"}

7. Update task status:
   [TOOL:update_task]{"id":"task_id","status":"completed|failed","result":"outcome"}

RULES:
- Always use RELATIVE paths from the project root (e.g., "src/services/NewService.ts")
- Before writing code, read existing files to understand the codebase
- After making changes, run "npx tsc --noEmit" to verify the build
- If the build fails, read the error, fix it, and verify again
- You can restart the dev server with: npx tsx watch src/api/server.ts
- Keep responses concise — focus on the code
- When done with a task, mark it completed
- If something fails, explain briefly and try an alternative approach
- Never modify node_modules or .env files

Respond naturally between tool calls. When you need to use a tool, output the exact format above.`;

export class BuilderService {
  private tasks: Map<string, BuilderTask> = new Map();
  private conversationHistory: { role: 'user' | 'assistant' | 'system'; content: string }[] = [];
  private maxHistoryTurns = 20;

  constructor() {
    this.conversationHistory.push({ role: 'system', content: BUILDER_SYSTEM_PROMPT });
  }

  private resolvePath(relativePath: string): string {
    // Prevent path traversal
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
   * Execute a tool call and return the result.
   */
  private executeTool(toolName: string, args: any): string {
    try {
      switch (toolName) {
        case 'read_file': {
          const absPath = this.resolvePath(this.sanitizePath(args.path));
          if (!existsSync(absPath)) return `Error: File not found: ${args.path}`;
          const content = readFileSync(absPath, 'utf-8');
          return content.length > 50000
            ? content.slice(0, 50000) + '\n... [truncated]'
            : content;
        }

        case 'write_file': {
          const absPath = this.resolvePath(this.sanitizePath(args.path));
          // Ensure parent directory exists
          const dir = join(absPath, '..');
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          writeFileSync(absPath, args.content, 'utf-8');
          return `Successfully wrote ${args.content.length} chars to ${args.path}`;
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
          const absPath = this.resolvePath(this.sanitizePath(args.path));
          if (!existsSync(absPath)) return `Error: File not found: ${args.path}`;
          unlinkSync(absPath);
          return `Deleted ${args.path}`;
        }

        case 'run_command': {
          // executeTool is sync, but run_command needs async
          // We handle this in the chat loop by calling runCommandAsync directly
          return `[Use run_command in chat loop - async execution required]`;
        }

        case 'create_task': {
          const id = `task_${Date.now()}`;
          const task: BuilderTask = {
            id,
            description: args.description,
            status: 'pending',
            createdAt: Date.now(),
          };
          this.tasks.set(id, task);
          return `Created task ${id}: ${args.description}`;
        }

        case 'update_task': {
          const task = this.tasks.get(args.id);
          if (!task) return `Error: Task ${args.id} not found`;
          task.status = args.status;
          task.result = args.result;
          return `Task ${args.id} updated to ${args.status}`;
        }

        default:
          return `Error: Unknown tool "${toolName}"`;
      }
    } catch (error: any) {
      return `Error executing ${toolName}: ${error.message}`;
    }
  }

  /**
   * Run a shell command asynchronously with a timeout.
   */
  private runCommandAsync(command: string): Promise<string> {
    return new Promise((resolve) => {
      const timeout = 30000;
      exec(command, { cwd: REPO_ROOT, timeout }, (error, stdout, stderr) => {
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
   * Returns array of { toolName, args, raw } objects.
   */
  private parseToolCalls(text: string): Array<{ toolName: string; args: any; raw: string }> {
    const toolRegex = /\[TOOL:(\w+)\]([\s\S]*?)(?=\[TOOL:|\n\n|$)/g;
    const calls: Array<{ toolName: string; args: any; raw: string }> = [];
    let match;

    while ((match = toolRegex.exec(text)) !== null) {
      const toolName = match[1];
      const argsStr = match[2].trim();
      try {
        const args = JSON.parse(argsStr);
        calls.push({ toolName, args, raw: match[0] });
      } catch {
        // If JSON parse fails, skip this tool call
        calls.push({ toolName, args: {}, raw: match[0] });
      }
    }

    return calls;
  }

  /**
   * Main chat loop with tool use.
   * Sends user message, lets model respond, executes tools, feeds results back.
   * Max 5 tool-use rounds to prevent infinite loops.
   */
  async *chatStream(userMessage: string): AsyncGenerator<string> {
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

    const maxRounds = 5;

    for (let round = 0; round < maxRounds; round++) {
      // Get model response with fallback
      let fullResponse = '';

      for await (const chunk of ollamaService.chatStreamWithFallback(
        this.conversationHistory,
        {}
      )) {
        if (chunk.startsWith('[META:')) {
          // Pass meta info to client
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
        // No tools to execute — we're done
        return;
      }

      // Execute tools and collect results
      const toolResults: string[] = [];
      for (const call of toolCalls) {
        yield `\n[EXECUTING: ${call.toolName}]\n`;

        let result: string;
        if (call.toolName === 'run_command') {
          result = await this.runCommandAsync(call.args.command || '');
        } else {
          result = this.executeTool(call.toolName, call.args);
        }

        toolResults.push(`[Result of ${call.toolName}]: ${result}`);

        // Yield tool result to client
        yield `[TOOL_RESULT:${call.toolName}]${result}\n`;
      }

      // Feed tool results back as a user message for the next round
      const resultsMessage = toolResults.join('\n\n');
      this.conversationHistory.push({
        role: 'user',
        content: `Here are the results of the tool calls:\n\n${resultsMessage}\n\nContinue based on these results. If the task is complete, summarize what was done. If there are errors, fix them.`,
      });
    }

    // If we hit max rounds, yield a notice
    yield '\n[Max tool-use rounds reached. Continuing the conversation will allow more operations.]';
  }

  /**
   * Get all tasks.
   */
  getTasks(): BuilderTask[] {
    return Array.from(this.tasks.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Clear conversation history.
   */
  resetConversation(): void {
    this.conversationHistory = [{ role: 'system', content: BUILDER_SYSTEM_PROMPT }];
  }

  /**
   * Get file tree for the project.
   */
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
