import { ApiProperty } from '@nestjs/swagger';
import { isRunnerOnline } from '../../common/runner-online';
import type { RunnerRecord } from '../domain/runner.domain';

/** The instant and threshold a DTO's `online` is computed against (D117). */
export interface RunnerView {
  now: Date;
  offlineSec: number;
}

export class RunnerDto {
  @ApiProperty() declare id: string;
  @ApiProperty() declare name: string;
  @ApiProperty({ enum: ['darwin', 'linux'] }) declare os: string;
  @ApiProperty({ enum: ['arm64', 'x64'] }) declare arch: string;
  @ApiProperty({ type: [String] }) declare labels: string[];
  @ApiProperty() declare capacity: number;
  @ApiProperty({ description: 'Most thread sessions this runner hosts (S5a); set by admins' }) declare threadCapacity: number;
  @ApiProperty({ type: Object }) declare capabilities: Record<string, unknown>;
  @ApiProperty() declare daemonVersion: string;
  @ApiProperty() declare protocolVersion: number;
  @ApiProperty({ description: 'Id of the daemon boot the runner last reported (#158)' }) declare bootId: string;
  @ApiProperty({ type: String, nullable: true, description: 'Start of the current daemon boot; null until the first boot after 2026-10-01' })
  declare bootedAt: string | null;
  @ApiProperty({ description: 'Synced within FLEET_RUNNER_OFFLINE_SEC (the placement rule)' }) declare online: boolean;
  @ApiProperty() declare enabled: boolean;
  @ApiProperty() declare lastSeenAt: string;
  @ApiProperty() declare createdAt: string;

  static from(r: RunnerRecord, view: RunnerView): RunnerDto {
    return Object.assign(new RunnerDto(), {
      id: r.id, name: r.name, os: r.os, arch: r.arch, labels: r.labels, capacity: r.capacity, threadCapacity: r.threadCapacity,
      capabilities: (r.capabilities ?? {}) as Record<string, unknown>, daemonVersion: r.daemonVersion,
      protocolVersion: r.protocolVersion, bootId: r.bootId, bootedAt: r.bootedAt ? r.bootedAt.toISOString() : null,
      online: isRunnerOnline(r.lastSeenAt, view.now, view.offlineSec), enabled: r.enabled,
      lastSeenAt: r.lastSeenAt.toISOString(), createdAt: r.createdAt.toISOString(),
    });
  }
}
