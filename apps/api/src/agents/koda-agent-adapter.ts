import { Injectable } from '@nestjs/common';
import { ContextBuilderService, type GetProjectContextQuery } from '../context/context-builder.service';
import { AgentRegistryService } from './agent-registry.service';

@Injectable()
export class KodaAgentAdapter {
  constructor(
    private readonly contextBuilderService: ContextBuilderService,
    private readonly registry: AgentRegistryService,
  ) {}

  async getContextForAgent(
    agentId: string,
    query: GetProjectContextQuery,
  ): Promise<string> {
    const ctx = await this.contextBuilderService.getProjectContext(query);
    return this.registry.getAdapter(agentId).formatContext(ctx);
  }
}
