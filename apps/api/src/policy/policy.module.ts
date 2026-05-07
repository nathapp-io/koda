import { Module } from '@nestjs/common';
import { PolicyGateService } from './policy-gate.service';

@Module({
  providers: [PolicyGateService],
  exports: [PolicyGateService],
})
export class PolicyModule {}
