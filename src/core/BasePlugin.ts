export interface PluginMetadata {
  name: string;
  version: string;
  description?: string;
  supportedActions: string[];
}

export abstract class BasePlugin {
  public abstract readonly metadata: PluginMetadata;

  /**
   * Standard initialization method called by the PluginManager.
   */
  public abstract init(): Promise<void>;

  /**
   * Core execution method for all plugin actions.
   * @param action The name of the action to perform.
   * @param data The payload/arguments for the action.
   */
  public abstract execute(action: string, data: any): Promise<any>;

  /**
   * Universal method for executing streaming actions.
   * Should be overridden by plugins that support token-by-token generation.
   */
  public async *executeStream(action: string, data: any): AsyncGenerator<string> {
    throw new Error(`Plugin "${this.metadata.name}" does not support streaming action "${action}".`);
  }

  /**
   * Graceful shutdown hook.
   */
  public abstract shutdown(): Promise<void>;

  /**
   * Check if the plugin supports a specific action.
   */
  public supports(action: string): boolean {
    return this.metadata.supportedActions.includes(action);
  }
}
