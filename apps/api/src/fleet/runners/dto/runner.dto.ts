import { ApiProperty } from '@nestjs/swagger';
import type { RunnerRecord } from '../domain/runner.domain';

export class RunnerDto {
  @ApiProperty() declare id: string;
  @ApiProperty() declare name: string;
  @ApiProperty({ enum: ['darwin', 'linux'] }) declare os: string;
  @ApiProperty({ enum: ['arm64', 'x64'] }) declare arch: string;
  @ApiProperty({ type: [String] }) declare labels: string[];
  @ApiProperty() declare capacity: number;
  @ApiProperty({ type: Object }) declare capabilities: Record<string, unknown>;
  @ApiProperty() declare daemonVersion: string;
  @ApiProperty() declare protocolVersion: number;
  @ApiProperty() declare enabled: boolean;
  @ApiProperty() declare lastSeenAt: string;
  @ApiProperty() declare createdAt: string;

  static from(r: RunnerRecord): RunnerDto {
    return Object.assign(new RunnerDto(), {
      id: r.id, name: r.name, os: r.os, arch: r.arch, labels: r.labels, capacity: r.capacity,
      capabilities: (r.capabilities ?? {}) as Record<string, unknown>, daemonVersion: r.daemonVersion,
      protocolVersion: r.protocolVersion, enabled: r.enabled, lastSeenAt: r.lastSeenAt.toISOString(),
      createdAt: r.createdAt.toISOString(),
    });
  }
}
