import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = join(__dirname, '../../model-config.json');

export type ModelType = 'cloud' | 'local';

export interface ModelConfig {
  id: string;           // unique identifier e.g. "nvidia-llama3.1-405b"
  name: string;         // display name e.g. "Llama 3.1 405B"
  type: ModelType;
  provider: string;     // e.g. "nvidia", "google", "anthropic", "ollama"
  modelId: string;      // API model ID e.g. "meta/llama-3.1-405b-instruct"
  apiKey?: string;      // API key (cloud only)
  baseUrl?: string;     // API base URL (cloud only, OpenAI-compatible)
  enabled: boolean;
  priority: number;     // lower = higher priority (1 = first choice)
  maxTokens?: number;   // max output tokens
  timeoutMs?: number;   // timeout for first token
  recommended?: boolean; // show recommendation badge in UI
  notes?: string;       // e.g. "Best for stock trading analysis"
}

export interface ModelConfigFile {
  cloudModels: ModelConfig[];
  localModels: ModelConfig[];
  autoMode: boolean; // global auto-switch toggle
}

const DEFAULT_CONFIG: ModelConfigFile = {
  cloudModels: [
    {
      id: 'nvidia-llama3.1-405b',
      name: 'Llama 3.1 405B',
      type: 'cloud',
      provider: 'nvidia',
      modelId: 'meta/llama-3.1-405b-instruct',
      apiKey: '',
      baseUrl: 'https://integrate.api.nvidia.com/v1',
      enabled: false,
      priority: 1,
      maxTokens: 4096,
      timeoutMs: 30000,
      recommended: true,
      notes: 'Best for stock trading, complex reasoning',
    },
    {
      id: 'nvidia-glm-5.1',
      name: 'GLM 5.1',
      type: 'cloud',
      provider: 'nvidia',
      modelId: 'nvidia/glm-5.1',
      apiKey: '',
      baseUrl: 'https://integrate.api.nvidia.com/v1',
      enabled: false,
      priority: 2,
      maxTokens: 4096,
      timeoutMs: 30000,
      recommended: true,
      notes: 'NVIDIA GLM 5.1 — general purpose',
    },
    {
      id: 'google-gemini-pro',
      name: 'Gemini 2.5 Pro',
      type: 'cloud',
      provider: 'google',
      modelId: 'gemini-2.5-pro-preview-06-05',
      apiKey: '',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      enabled: false,
      priority: 3,
      maxTokens: 8192,
      timeoutMs: 30000,
      recommended: true,
      notes: 'Google Gemini — multimodal, long context',
    },
    {
      id: 'anthropic-opus',
      name: 'Claude Opus 4',
      type: 'cloud',
      provider: 'anthropic',
      modelId: 'claude-opus-4-20250514',
      apiKey: '',
      baseUrl: 'https://api.anthropic.com/v1',
      enabled: false,
      priority: 4,
      maxTokens: 4096,
      timeoutMs: 30000,
      recommended: true,
      notes: 'Anthropic Claude — best for code & analysis',
    },
  ],
  localModels: [
    {
      id: 'local-phi3.5',
      name: 'Phi 3.5',
      type: 'local',
      provider: 'ollama',
      modelId: 'phi3.5:latest',
      enabled: true,
      priority: 1,
      timeoutMs: 4000,
      recommended: true,
      notes: 'Smart local model — good balance',
    },
    {
      id: 'local-llama3.2-1b',
      name: 'Llama 3.2 1B',
      type: 'local',
      provider: 'ollama',
      modelId: 'llama3.2:1b',
      enabled: true,
      priority: 2,
      timeoutMs: 3000,
      recommended: false,
      notes: 'Fastest local model',
    },
    {
      id: 'local-qwen2.5-1.5b',
      name: 'Qwen 2.5 1.5B',
      type: 'local',
      provider: 'ollama',
      modelId: 'qwen2.5:1.5b',
      enabled: true,
      priority: 3,
      timeoutMs: 3000,
    },
    {
      id: 'local-gemma2-2b',
      name: 'Gemma 2 2B',
      type: 'local',
      provider: 'ollama',
      modelId: 'gemma2:2b',
      enabled: true,
      priority: 4,
      timeoutMs: 3000,
    },
    {
      id: 'local-tinyllama',
      name: 'TinyLlama',
      type: 'local',
      provider: 'ollama',
      modelId: 'tinyllama:latest',
      enabled: true,
      priority: 5,
      timeoutMs: 2000,
    },
    {
      id: 'local-mistral',
      name: 'Mistral',
      type: 'local',
      provider: 'ollama',
      modelId: 'mistral:latest',
      enabled: true,
      priority: 6,
      timeoutMs: 5000,
      recommended: true,
      notes: 'Best local quality — slower',
    },
  ],
  autoMode: true,
};

class ModelConfigService {
  private config: ModelConfigFile;

  constructor() {
    this.config = this.load();
  }

  private load(): ModelConfigFile {
    if (existsSync(CONFIG_PATH)) {
      try {
        const raw = readFileSync(CONFIG_PATH, 'utf-8');
        return JSON.parse(raw) as ModelConfigFile;
      } catch {
        console.warn('[ModelConfigService] Failed to parse config, using defaults');
      }
    }
    // First run — write defaults
    this.save(DEFAULT_CONFIG);
    return { ...DEFAULT_CONFIG };
  }

  private save(cfg?: ModelConfigFile): void {
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg || this.config, null, 2));
  }

  /** Get full config */
  getConfig(): ModelConfigFile {
    return this.config;
  }

  /** Get ordered list of all enabled models (cloud first, then local) */
  getActiveChain(): ModelConfig[] {
    const cloud = this.config.cloudModels
      .filter(m => m.enabled && m.apiKey)
      .sort((a, b) => a.priority - b.priority);
    const local = this.config.localModels
      .filter(m => m.enabled)
      .sort((a, b) => a.priority - b.priority);
    return [...cloud, ...local];
  }

  /** Get a specific model by id */
  getModel(id: string): ModelConfig | undefined {
    return [...this.config.cloudModels, ...this.config.localModels].find(m => m.id === id);
  }

  /** Add or update a cloud model */
  setCloudModel(model: ModelConfig): void {
    const idx = this.config.cloudModels.findIndex(m => m.id === model.id);
    if (idx >= 0) {
      this.config.cloudModels[idx] = model;
    } else {
      model.type = 'cloud';
      this.config.cloudModels.push(model);
    }
    this.save();
  }

  /** Add or update a local model */
  setLocalModel(model: ModelConfig): void {
    const idx = this.config.localModels.findIndex(m => m.id === model.id);
    if (idx >= 0) {
      this.config.localModels[idx] = model;
    } else {
      model.type = 'local';
      this.config.localModels.push(model);
    }
    this.save();
  }

  /** Delete a model by id */
  deleteModel(id: string): boolean {
    let removed = false;
    this.config.cloudModels = this.config.cloudModels.filter(m => {
      if (m.id === id) { removed = true; return false; }
      return true;
    });
    this.config.localModels = this.config.localModels.filter(m => {
      if (m.id === id) { removed = true; return false; }
      return true;
    });
    if (removed) this.save();
    return removed;
  }

  /** Toggle enabled/disabled */
  toggleModel(id: string): ModelConfig | undefined {
    const model = this.getModel(id);
    if (model) {
      model.enabled = !model.enabled;
      this.save();
    }
    return model;
  }

  /** Reorder priorities for cloud models */
  reorderCloud(order: string[]): void {
    this.config.cloudModels.sort((a, b) => {
      const ai = order.indexOf(a.id);
      const bi = order.indexOf(b.id);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });
    this.config.cloudModels.forEach((m, i) => (m.priority = i + 1));
    this.save();
  }

  /** Reorder priorities for local models */
  reorderLocal(order: string[]): void {
    this.config.localModels.sort((a, b) => {
      const ai = order.indexOf(a.id);
      const bi = order.indexOf(b.id);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });
    this.config.localModels.forEach((m, i) => (m.priority = i + 1));
    this.save();
  }

  /** Set auto mode */
  setAutoMode(enabled: boolean): void {
    this.config.autoMode = enabled;
    this.save();
  }

  /** Test if a cloud model's API key works */
  async testCloudModel(id: string): Promise<{ ok: boolean; error?: string; latencyMs?: number }> {
    const model = this.getModel(id);
    if (!model || model.type !== 'cloud') return { ok: false, error: 'Model not found or not cloud' };
    if (!model.apiKey || !model.baseUrl) return { ok: false, error: 'API key or base URL missing' };

    const start = Date.now();
    try {
      const url = `${model.baseUrl}/chat/completions`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${model.apiKey}`,
        },
        body: JSON.stringify({
          model: model.modelId,
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: 5,
        }),
        signal: AbortSignal.timeout(model.timeoutMs || 15000),
      });

      if (res.ok) {
        return { ok: true, latencyMs: Date.now() - start };
      }
      const body = await res.text();
      return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  }
}

export const modelConfigService = new ModelConfigService();
