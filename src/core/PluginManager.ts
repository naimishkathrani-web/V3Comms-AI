import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { BasePlugin } from './BasePlugin.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class PluginManager {
  private plugins: Map<string, BasePlugin> = new Map();
  private isInitialized: boolean = false;

  constructor() {
    console.log('[PluginManager] Initializing system...');
  }

  /**
   * Dynamically loads all plugins from the specified directory.
   */
  public async loadPlugins(pluginsDir: string): Promise<void> {
    const absolutePath = path.resolve(pluginsDir);
    
    if (!fs.existsSync(absolutePath)) {
      console.warn(`[PluginManager] Plugins directory not found: ${absolutePath}`);
      return;
    }

    const files = fs.readdirSync(absolutePath);
    console.log(`[PluginManager] Scanning directory: ${absolutePath}`);

    for (const file of files) {
      if (file.endsWith('.ts') || file.endsWith('.js')) {
        // Skip declaration files
        if (file.endsWith('.d.ts')) continue;

        try {
          const filePath = path.join(absolutePath, file);
          const fileUrl = pathToFileURL(filePath).href;
          
          const module = await import(fileUrl);
          
          // Expecting a default export or a class that we can instantiate
          // For simplicity, we assume each file exports a class we can identify
          const PluginClass = module.default || Object.values(module)[0];

          if (typeof PluginClass === 'function') {
            const pluginInstance = new PluginClass();
            if (pluginInstance instanceof BasePlugin) {
              this.registerPlugin(pluginInstance);
            }
          }
        } catch (error) {
          console.error(`[PluginManager] Failed to load plugin from ${file}:`, error);
        }
      }
    }
  }

  public registerPlugin(plugin: BasePlugin): void {
    const { name } = plugin.metadata;
    if (this.plugins.has(name)) {
      throw new Error(`Plugin "${name}" already registered.`);
    }
    this.plugins.set(name, plugin);
    console.log(`[PluginManager] Registered: ${name} v${plugin.metadata.version}`);
  }

  public async boot(): Promise<void> {
    if (this.isInitialized) return;

    for (const [name, plugin] of this.plugins) {
      try {
        await plugin.init();
        console.log(`[PluginManager] ${name} initialized.`);
      } catch (error) {
        console.error(`[PluginManager] ${name} init failed:`, error);
      }
    }
    this.isInitialized = true;
    console.log('[PluginManager] System ready.');
  }

  public async execute(pluginName: string, action: string, data: any): Promise<any> {
    const plugin = this.plugins.get(pluginName);
    if (!plugin) throw new Error(`Plugin "${pluginName}" not found.`);
    
    if (!plugin.supports(action)) {
      throw new Error(`Plugin "${pluginName}" does not support action "${action}".`);
    }

    return await plugin.execute(action, data);
  }

  public async *executeStream(pluginName: string, action: string, data: any): AsyncGenerator<string> {
    const plugin = this.plugins.get(pluginName);
    if (!plugin) throw new Error(`Plugin "${pluginName}" not found.`);
    
    if (!plugin.supports(action)) {
      throw new Error(`Plugin "${pluginName}" does not support action "${action}".`);
    }

    yield* plugin.executeStream(action, data);
  }

  public listPlugins() {
    return Array.from(this.plugins.values()).map(p => p.metadata);
  }

  public async shutdown(): Promise<void> {
    for (const plugin of this.plugins.values()) {
      await plugin.shutdown();
    }
    console.log('[PluginManager] Shutdown complete.');
  }
}
