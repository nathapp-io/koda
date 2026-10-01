import { ApiProperty } from '@nestjs/swagger';
import { isRunnerOnline } from '../../common/runner-online';
import type { RunnerRecord } from '../domain/runner.domain';
import type { RunnerView } from './runner.dto';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Machine profile names from a stored capability report; [] when the report has none (D118). */
function profileNames(capabilities: unknown): string[] {
  if (!isRecord(capabilities) || !isRecord(capabilities['profiles'])) return [];
  return Object.keys(capabilities['profiles']).sort();
}

/**
 * What a project member needs to dispatch (labels, pin, profile chain) and to name runners in job
 * lists (overview D118). No versions, capacity, credentials or sandbox detail.
 */
export class RunnerSummaryDto {
  @ApiProperty() declare id: string;
  @ApiProperty() declare name: string;
  @ApiProperty({ enum: ['darwin', 'linux'] }) declare os: string;
  @ApiProperty({ enum: ['arm64', 'x64'] }) declare arch: string;
  @ApiProperty({ type: [String] }) declare labels: string[];
  @ApiProperty() declare enabled: boolean;
  @ApiProperty({ description: 'Synced within FLEET_RUNNER_OFFLINE_SEC (the placement rule)' }) declare online: boolean;
  @ApiProperty({ type: [String], description: 'Machine profile names, sorted' }) declare profiles: string[];

  static from(r: RunnerRecord, view: RunnerView): RunnerSummaryDto {
    return Object.assign(new RunnerSummaryDto(), {
      id: r.id, name: r.name, os: r.os, arch: r.arch, labels: r.labels, enabled: r.enabled,
      online: isRunnerOnline(r.lastSeenAt, view.now, view.offlineSec), profiles: profileNames(r.capabilities),
    });
  }
}
