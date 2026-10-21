import { CodeIntelController } from '../../../src/code-intel/code-intel.controller';
import { PERMISSION_KEY } from '@nathapp/nestjs-auth';
import { PROJECT_SLUG_FROM_KEY } from '../../../src/projects/project-slug-from.decorator';
import { REQUIRES_METADATA } from '../../../src/permissions/requires.decorator';

describe('CodeIntelController permission metadata', () => {
  const reads = [
    CodeIntelController.prototype.searchSymbols,
    CodeIntelController.prototype.getSymbol,
    CodeIntelController.prototype.getCallers,
    CodeIntelController.prototype.getCallees,
  ];

  it('declares the index write key and body project slug source', () => {
    const index = CodeIntelController.prototype.indexCommit;
    expect(Reflect.getMetadata(REQUIRES_METADATA, index)).toMatchObject({ keys: ['codeintel.index.write'] });
    expect(Reflect.getMetadata(PROJECT_SLUG_FROM_KEY, index)).toEqual({ source: 'body', key: 'projectSlug' });
    expect(Reflect.getMetadata(PERMISSION_KEY, index)).toBeUndefined();
  });

  it.each(reads)('declares codeintel.read and removes legacy permission decorators', (handler) => {
    expect(Reflect.getMetadata(REQUIRES_METADATA, handler)).toMatchObject({ keys: ['codeintel.read'] });
    expect(Reflect.getMetadata(PERMISSION_KEY, handler)).toBeUndefined();
  });
});
