import { ApiProperty } from '@nestjs/swagger';
import { isRunnerOnline } from '../../common/runner-online';
import { parseAcpOffers } from '../../common/capabilities-core';
import { THREAD_AGENTS, type ThreadAgent, type ThreadBackends } from '../../common/thread-jobs';
import type { RunnerRecord } from '../domain/runner.domain';
import type { RunnerView } from './runner.dto';
import { THREAD_MIN_PROTOCOL_VERSION } from '../../threads/thread-send-rules';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Machine profile names from a stored capability report; [] when the report has none (D118). */
function profileNames(capabilities: unknown): string[] {
  if (!isRecord(capabilities) || !isRecord(capabilities['profiles'])) return [];
  return Object.keys(capabilities['profiles']).sort();
}

function threadBackends(capabilities: unknown, protocolVersion: number): ThreadBackends {
  const empty = { native: [], acp: [] };
  if (protocolVersion < THREAD_MIN_PROTOCOL_VERSION || !isRecord(capabilities) || !isRecord(capabilities['threadBackends'])) return empty;
  const backends = capabilities['threadBackends'];
  const native = backends['native'];
  const acp = backends['acp'];
  if (!Array.isArray(native) || !native.every((value): value is string => typeof value === 'string') ||
      !Array.isArray(acp) || !acp.every((value): value is string => typeof value === 'string')) return empty;
  // thread-agents-modes US-001 AC-7: the picker needs each agent's models and efforts. The list is re-validated here
  // (the report is stored input) and dropped alone when malformed, so the agent lists beside it still surface. The
  // agents themselves were checked against `ThreadAgent` when the report was parsed, so the cast is a restatement.
  const acpOffers = parseAcpOffers(backends['acpOffers']);
  return { native, acp: acp as ThreadAgent[], ...(acpOffers ? { acpOffers } : {}) };
}

/** Fleet S5b §2: true only when the runner is at the thread protocol floor and its stored report advertises projectThreads. */
function hasProjectThreads(capabilities: unknown, protocolVersion: number): boolean {
  if (protocolVersion < THREAD_MIN_PROTOCOL_VERSION || !isRecord(capabilities)) return false;
  return capabilities['projectThreads'] === true;
}

/** Fleet S5b 1d: the same rule for the WORKSPACE opt-in (absent on a runner that predates the kind). */
function hasWorkspaceThreads(capabilities: unknown, protocolVersion: number): boolean {
  if (protocolVersion < THREAD_MIN_PROTOCOL_VERSION || !isRecord(capabilities)) return false;
  return capabilities['workspaceThreads'] === true;
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
  @ApiProperty({
    type: 'object',
    description: 'Thread backends: `native` model ids, `acp` agents a thread can start, and `acpOffers` discovery detail (thread-agents-modes)',
    properties: {
      native: { type: 'array', items: { type: 'string' } },
      acp: { type: 'array', items: { type: 'string', enum: [...THREAD_AGENTS] } },
      acpOffers: {
        type: 'array',
        description: 'One bounded offer per probeable ACP agent; absent when the runner reports none',
        items: {
          type: 'object',
          properties: {
            agent: { type: 'string', enum: [...THREAD_AGENTS] },
            launchable: { type: 'boolean' },
            loggedIn: { type: 'boolean', nullable: true, description: 'null when not probed or the probe failed' },
            models: { type: 'array', items: { type: 'string' } },
            efforts: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  }) declare threadBackends: ThreadBackends;
  @ApiProperty({ description: 'Fleet S5b: the runner hosts PROJECT threads with no checkout' }) declare projectThreads: boolean;
  @ApiProperty({ description: 'Fleet S5b 1d: the runner hosts WORKSPACE threads with no checkout' }) declare workspaceThreads: boolean;

  static from(r: RunnerRecord, view: RunnerView): RunnerSummaryDto {
    return Object.assign(new RunnerSummaryDto(), {
      id: r.id, name: r.name, os: r.os, arch: r.arch, labels: r.labels, enabled: r.enabled,
      online: isRunnerOnline(r.lastSeenAt, view.now, view.offlineSec), profiles: profileNames(r.capabilities),
      threadBackends: threadBackends(r.capabilities, r.protocolVersion),
      projectThreads: hasProjectThreads(r.capabilities, r.protocolVersion),
      workspaceThreads: hasWorkspaceThreads(r.capabilities, r.protocolVersion),
    });
  }
}
