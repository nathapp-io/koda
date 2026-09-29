import { Module } from '@nestjs/common';
import { FleetActivityModule } from './activity/fleet-activity.module';

/** Fleet S1 (spec docs/superpowers/specs/2026-09-29-fleet-s1-dispatch-design.md). */
@Module({
  imports: [FleetActivityModule],
})
export class FleetModule {}
