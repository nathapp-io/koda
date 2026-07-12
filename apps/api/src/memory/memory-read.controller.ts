// Stub — to be replaced by the implementer.
// This file exists only so spec files can import the class and fail at assertion level.
import { Controller } from '@nestjs/common';
import { MemoryGovernanceService } from './memory-governance.service';
import { ProjectsService } from '../projects/projects.service';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';

@Controller('projects/:slug/memory')
export class MemoryReadController {
  constructor(
    _governance: MemoryGovernanceService,
    _projects: ProjectsService,
  ) {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async getMemory(
    _slug: string,
    _principal: KodaPrincipal,
    _kind?: string,
    _subject?: string,
    _status?: string,
    _page?: string,
    _limit?: string,
    _orderBy?: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    return undefined;
  }
}
