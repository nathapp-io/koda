import { Module, OnModuleInit } from '@nestjs/common';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { AgentRegistryService } from './agent-registry.service';
import { KodaAgentAdapter } from './koda-agent-adapter';
import { ClaudeCodeAdapter } from './adapters/claude-code.adapter';
import { NaxAdapter } from './adapters/nax.adapter';
import { CopilotAdapter } from './adapters/copilot.adapter';
import { KodaDomainWriterModule } from '../koda-domain-writer/koda-domain-writer.module';
import { AuthModule } from '../auth/auth.module';
import { ContextModule } from '../context/context.module';

@Module({
  imports: [KodaDomainWriterModule, AuthModule, ContextModule],
  controllers: [AgentsController],
  providers: [
    AgentsService,
    AgentRegistryService,
    KodaAgentAdapter,
  ],
  exports: [AgentsService, AgentRegistryService, KodaAgentAdapter],
})
export class AgentsModule implements OnModuleInit {
  constructor(private readonly registry: AgentRegistryService) {}

  onModuleInit(): void {
    this.registry.register('claude-code', new ClaudeCodeAdapter());
    this.registry.register('nax', new NaxAdapter());
    this.registry.register('copilot', new CopilotAdapter());
  }
}
