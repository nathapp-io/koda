import { Module } from '@nestjs/common';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { KodaDomainWriterModule } from '../koda-domain-writer/koda-domain-writer.module';

@Module({
  imports: [KodaDomainWriterModule],
  controllers: [AgentsController],
  providers: [AgentsService],
  exports: [AgentsService],
})
export class AgentsModule {}
