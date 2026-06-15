import { Module } from '@nestjs/common';
import { PolicyGateService } from './policy-gate.service';
import { PrismaPolicyRepository } from './prisma-policy.repository';
import { MemoryModule } from '../memory/memory.module';
import { ContextModule } from '../context/context.module';

@Module({
  imports: [MemoryModule, ContextModule],
  providers: [PrismaPolicyRepository, PolicyGateService],
  exports: [PolicyGateService],
})
export class PolicyModule {}
