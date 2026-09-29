import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { ProjectAccessModule } from '../../projects/project-access.module';
import { FleetActivityModule } from '../activity/fleet-activity.module';
import { FleetJobsModule } from '../jobs/fleet-jobs.module';
import { SyncModule } from '../sync/sync.module';
import { ARTIFACT_STORE } from './artifact-store';
import { BundleService } from './bundle.service';
import { BundleUploadController } from './bundle-upload.controller';
import { JobBundleController } from './job-bundle.controller';
import { LocalDiskArtifactStore } from './local-disk-artifact.store';

@Module({
  imports: [PrismaModule, ProjectAccessModule, FleetActivityModule, FleetJobsModule, SyncModule],
  controllers: [BundleUploadController, JobBundleController],
  providers: [LocalDiskArtifactStore, { provide: ARTIFACT_STORE, useExisting: LocalDiskArtifactStore }, BundleService],
})
export class ArtifactsModule {}
