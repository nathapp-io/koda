import { ApiProperty } from '@nestjs/swagger';
import { isRunnerOnline } from '../../common/runner-online';
import type { RunnerRecord } from '../domain/runner.domain';
import type { RunnerView } from './runner.dto';
import { THREAD_MIN_PROTOCOL_VERSION } from '../../threads/thread-send-rules';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Machine profile names from a stored capability report; [] when the report has none (D118). */
function profileNames(capabilities: unknown): string[] {
  if (!isRecord(capabilities) || !isRecord(capabilities['profiles'])) return [];
  return Object.keys(capabilities['profiles']).sort();
}

function threadBackends(capabilities: unknown, protocolVersion: number): { native: string[]; acp: string[] } {
  const empty = { native: [], acp: [] };
  if (protocolVersion < THREAD_MIN_PROTOCOL_VERSION || !isRecord(capabilities) || !isRecord(capabilities['threadBackends'])) return empty;
  const backends = capabilities['threadBackends'];
  const native = backends['native'];
  const acp = backends['acp'];
  if (!Array.isArray(native) || !native.every((value): value is string => typeof value === 'string') ||
      !Array.isArray(acp) || !acp.every((value): value is string => typeof value === 'string')) return empty;
  return { native, acp };
}

/** Fleet S5b §2: true only when the runner is at the thread protocol floor and its stored report advertises projectThreads. */
function hasProjectThreads(capabilities: unknown, protocolVersion: number): boolean {
  if (protocolVersion < THREAD_MIN_PROTOCOL_VERSION || !isRecord(capabilities)) return false;
  return capabilities['projectThreads'] === true;
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
  @ApiProperty({ type: 'object', properties: { native: { type: 'array', items: { type: 'string' } }, acp: { type: 'array', items: { type: 'string' } } } }) declare threadBackends: { native: string[]; acp: string[] };
  @ApiProperty({ description: 'Fleet S5b: the runner hosts PROJECT threads with no checkout' }) declare projectThreads: boolean;

  static from(r: RunnerRecord, view: RunnerView): RunnerSummaryDto {
    return Object.assign(new RunnerSummaryDto(), {
      id: r.id, name: r.name, os: r.os, arch: r.arch, labels: r.labels, enabled: r.enabled,
      online: isRunnerOnline(r.lastSeenAt, view.now, view.offlineSec), profiles: profileNames(r.capabilities),
      threadBackends: threadBackends(r.capabilities, r.protocolVersion),
      projectThreads: hasProjectThreads(r.capabilities, r.protocolVersion),
    });
  }
}
