import { Module } from '@nestjs/common';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { KodaDomainWriterModule } from '../koda-domain-writer/koda-domain-writer.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [KodaDomainWriterModule, AuthModule],
  controllers: [AgentsController],
  providers: [AgentsService],
  exports: [AgentsService],
})
export class AgentsModule {}
