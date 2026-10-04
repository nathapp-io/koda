import { Module } from '@nestjs/common';
import { ARTIFACT_STORE } from './artifact-store';
import { LocalDiskArtifactStore } from './local-disk-artifact.store';

/** Plan D309: the artifact store on its own so the logs module can read bundles without importing ArtifactsModule. */
@Module({
  providers: [LocalDiskArtifactStore, { provide: ARTIFACT_STORE, useExisting: LocalDiskArtifactStore }],
  exports: [ARTIFACT_STORE],
})
export class ArtifactStoreModule {}
