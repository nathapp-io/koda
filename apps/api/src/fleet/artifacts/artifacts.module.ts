import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { ProjectAccessModule } from '../../projects/project-access.module';
import { FleetActivityModule } from '../activity/fleet-activity.module';
import { FleetJobsModule } from '../jobs/fleet-jobs.module';
import { SyncModule } from '../sync/sync.module';
import { ArtifactStoreModule } from './artifact-store.module';
import { BundleService } from './bundle.service';
import { BundleUploadController } from './bundle-upload.controller';
import { JobBundleController } from './job-bundle.controller';

@Module({
  imports: [PrismaModule, ProjectAccessModule, FleetActivityModule, FleetJobsModule, SyncModule, ArtifactStoreModule],
  controllers: [BundleUploadController, JobBundleController],
  providers: [BundleService],
})
export class ArtifactsModule {}
