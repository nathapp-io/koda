import { Module } from '@nestjs/common';
import { PolicyGateService } from './policy-gate.service';
import { MemoryModule } from '../memory/memory.module';
import { ContextModule } from '../context/context.module';

@Module({
  imports: [MemoryModule, ContextModule],
  providers: [PolicyGateService],
  exports: [PolicyGateService],
})
export class PolicyModule {}
