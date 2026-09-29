import { Inject, Injectable } from '@nestjs/common';
import { AuthException } from '@nathapp/nestjs-common';
import type { IPageOption } from '@nathapp/nestjs-common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import type { IPageResult } from '@nathapp/nestjs-data';
import { AUTH_CFG, IAuthConfig } from '../../config/auth.config';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { remapPage } from '../../common/dto/koda-page.query';
import { FleetActivityService } from '../activity/fleet-activity.service';
import { parseCapabilities } from '../common/capabilities';
import { generateEnrollmentToken, generateRunnerKey, hashSecret } from '../common/fleet-keys';
import { isSupportedProtocolVersion } from '../common/protocol';
import { IRunnerRepository, RUNNER_REPOSITORY } from './domain/runner.domain';
import { EnrollDto } from './dto/enroll.dto';
import { EnrollmentCreatedDto, EnrollmentDto } from './dto/enrollment.dto';
import { ProtocolVersionException } from './protocol-version.exception';

const uniqueSorted = (labels: string[]) => [...new Set(labels)].sort();

@Injectable()
export class EnrollmentService {
  constructor(
    @Inject(RUNNER_REPOSITORY) private readonly repo: IRunnerRepository,
    private readonly activity: FleetActivityService,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    @Inject(AUTH_CFG) private readonly authConfig: IAuthConfig,
    @Inject(FLEET_CFG) private readonly fleetConfig: IFleetConfig,
  ) {}

  async create(actorId: string, labels: string[]): Promise<EnrollmentCreatedDto> {
    const { raw, hash } = generateEnrollmentToken(this.authConfig.apiKeySecret ?? '');
    const cleanLabels = uniqueSorted(labels);
    const expiresAt = new Date(Date.now() + this.fleetConfig.enrollmentTtlSec * 1000);
    const enrollment = await this.txManager.run(async () => {
      const row = await this.repo.createEnrollment({ tokenHash: hash, labels: cleanLabels, expiresAt, createdById: actorId });
      await this.activity.record({ actorType: 'USER', actorId, action: 'enrollment.created', entityType: 'enrollment', entityId: row.id, payload: { labels: cleanLabels } });
      return row;
    });
    return EnrollmentCreatedDto.from(enrollment, raw);
  }

  async list(page: IPageOption): Promise<IPageResult<EnrollmentDto>> {
    return remapPage(await this.repo.findEnrollmentPage(page), EnrollmentDto.from);
  }

  async enroll(body: EnrollDto): Promise<{ runnerId: string; apiKey: string }> {
    if (!isSupportedProtocolVersion(body.protocolVersion)) throw new ProtocolVersionException(body.protocolVersion);
    const capabilities = parseCapabilities(body.capabilities);
    const secret = this.authConfig.apiKeySecret ?? '';
    const tokenHash = hashSecret(secret, body.enrollmentToken);
    const { raw: apiKey, hash: apiKeyHash } = generateRunnerKey(secret);
    const now = new Date();

    const runner = await this.txManager.run(async () => {
      const enrollment = await this.repo.consumeEnrollment(tokenHash, now);
      if (!enrollment) throw new AuthException({}, 'fleet.enroll');
      const created = await this.repo.createRunner({
        name: body.name,
        apiKeyHash,
        os: body.os,
        arch: body.arch,
        labels: uniqueSorted([...enrollment.labels, ...body.labels]),
        capabilities,
        daemonVersion: body.daemonVersion,
        protocolVersion: body.protocolVersion,
        bootId: body.bootId,
        lastSeenAt: now,
        createdById: enrollment.createdById,
      });
      await this.repo.linkEnrollment(enrollment.id, created.id);
      await this.activity.record({
        actorType: 'RUNNER', actorId: created.id, action: 'runner.enrolled', entityType: 'runner', entityId: created.id,
        responsibleUserId: enrollment.createdById, payload: { name: created.name, labels: created.labels, enrollmentId: enrollment.id },
      });
      return created;
    });
    return { runnerId: runner.id, apiKey };
  }
}
