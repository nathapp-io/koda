import { Inject, Injectable } from '@nestjs/common';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { ProviderCredentialsService } from '../provider-credentials/provider-credentials.service';
import { isRunnerOnline } from '../common/runner-online';
import { buildCredentialBoard, CredentialBoard } from './credential-board';
import { readCapabilities } from './dashboard-view';
import { DASHBOARD_REPOSITORY, IDashboardRepository } from './domain/dashboard.domain';

type BoardConfig = Pick<IFleetConfig, 'runnerOfflineSec' | 'credentialExpiryWarnDays'>;

/** Fleet S3 §4.4: one read of every runner; the board is derived, never stored. */
@Injectable()
export class CredentialBoardService {
  constructor(
    @Inject(DASHBOARD_REPOSITORY) private readonly repo: IDashboardRepository,
    @Inject(FLEET_CFG) private readonly cfg: BoardConfig,
    /**
     * C10 US-007: the vault's public service, for the `kodaKeys` column. The repository stays inside
     * `ProviderCredentialsModule`; this only accepts the metadata projection it answers.
     */
    private readonly credentials: ProviderCredentialsService,
  ) {}

  async board(now: Date): Promise<CredentialBoard> {
    const [runners, kodaKeys] = await Promise.all([
      this.repo.findRunners(),
      this.credentials.listActiveGlobalKeys(),
    ]);
    return buildCredentialBoard(
      runners.map((r) => ({
        id: r.id, name: r.name, enabled: r.enabled,
        online: isRunnerOnline(r.lastSeenAt, now, this.cfg.runnerOfflineSec),
        capabilities: readCapabilities(r.capabilities),
      })),
      now,
      this.cfg.credentialExpiryWarnDays,
      kodaKeys,
    );
  }
}
