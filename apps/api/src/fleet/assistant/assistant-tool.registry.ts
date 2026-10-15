import { Injectable } from '@nestjs/common';
import type { AssistantTool } from './assistant-tool.types';

/** The koda tools the executor can run. Each tool group registers its tools in `onModuleInit` (1b-D7). */
@Injectable()
export class AssistantToolRegistry {
  private readonly tools = new Map<string, AssistantTool>();

  register(...tools: AssistantTool[]): void {
    for (const tool of tools) {
      const { name } = tool.descriptor;
      if (this.tools.has(name)) throw new Error(`koda tool already registered: ${name}`);
      this.tools.set(name, tool);
    }
  }

  get(name: string): AssistantTool | undefined {
    return this.tools.get(name);
  }
}
