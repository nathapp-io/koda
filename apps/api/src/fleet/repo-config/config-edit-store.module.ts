import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { CONFIG_EDIT_REPOSITORY } from './domain/config-edit.domain';
import { PrismaConfigEditRepository } from './prisma-config-edit.repository';

/** Fleet S3: FleetConfigEdit storage, importable by jobs (detail DTO) and repo-config without a module cycle (ApprovalStoreModule pattern). */
@Module({
  imports: [PrismaModule],
  providers: [PrismaConfigEditRepository, { provide: CONFIG_EDIT_REPOSITORY, useExisting: PrismaConfigEditRepository }],
  exports: [CONFIG_EDIT_REPOSITORY],
})
export class ConfigEditStoreModule {}
