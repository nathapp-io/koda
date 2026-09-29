import { Module } from '@nestjs/common';
import { FleetActivityModule } from './activity/fleet-activity.module';
import { RunnersModule } from './runners/runners.module';

/** Fleet S1 (spec docs/superpowers/specs/2026-09-29-fleet-s1-dispatch-design.md). */
@Module({
  imports: [FleetActivityModule, RunnersModule],
})
export class FleetModule {}
