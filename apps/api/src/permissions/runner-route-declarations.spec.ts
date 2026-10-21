import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { BundleUploadController } from '../fleet/artifacts/bundle-upload.controller';
import { RunnerToolController } from '../fleet/assistant/runner-tool.controller';
import { LogUploadController } from '../fleet/logs/log-upload.controller';
import { RunnerConfigEditController } from '../fleet/repo-config/runner-config-edit.controller';
import { RunnerApiController } from '../fleet/runners/runner-api.controller';
import { RunnerSyncController } from '../fleet/sync/runner-sync.controller';
import { RequiresGuard } from './requires.guard';
import { REQUIRES_METADATA, type RequiresMetadata } from './requires.decorator';

const routes = [
  [BundleUploadController, 'upload', 'runner.bundle.upload', 'guard'],
  [RunnerToolController, 'call', 'runner.tool.call', 'guard'],
  [LogUploadController, 'append', 'runner.log.append', 'guard'],
  [RunnerConfigEditController, 'get', 'runner.config.read', 'guard'],
  [RunnerApiController, 'me', 'runner.self.read', 'guard'],
  [RunnerSyncController, 'sync', 'runner.sync', 'guard'],
  [RunnerApiController, 'enroll', 'runner.enroll', 'service'],
] as const;

describe('runner route permission declarations', () => {
  const reflector = new Reflector();

  it('AC-5: declares the complete runner route key map', () => {
    for (const [controller, handlerName, key, enforcedBy] of routes) {
      const handler = controller.prototype[handlerName] as () => void;
      expect(reflector.get<RequiresMetadata>(REQUIRES_METADATA, handler)).toEqual({
        keys: [key], mode: 'all', enforcedBy,
      });
    }
  });

  it('AC-6: applies RequiresGuard at class scope to each runner controller', () => {
    const controllers = [BundleUploadController, RunnerToolController, LogUploadController, RunnerConfigEditController, RunnerApiController, RunnerSyncController];
    for (const controller of controllers) {
      expect(Reflect.getMetadata(GUARDS_METADATA, controller)).toContain(RequiresGuard);
    }
  });
});
