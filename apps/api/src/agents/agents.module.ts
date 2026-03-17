import { Module } from '@nestjs/common';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { ApiKeyAuthGuard } from '../auth/guards/api-key-auth.guard';

@Module({
  controllers: [AgentsController],
  providers: [AgentsService, ApiKeyAuthGuard],
  exports: [AgentsService, ApiKeyAuthGuard],
})
export class AgentsModule {}
