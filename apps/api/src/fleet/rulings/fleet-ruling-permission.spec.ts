import { findCatalogEntry, PENDING_SURFACE_KEYS } from '../../permissions/catalog';

describe('fleet ruling permission', () => {
  it('AC-13: is project scoped and approvable without default approval', () => {
    expect(findCatalogEntry('fleet.job.rule')).toMatchObject({ scope: 'project', approval: { approvable: true, floor: 'none', default: 'none' } });
  });
  it('exposes a real permission surface rather than a pending key', () => {
    expect(PENDING_SURFACE_KEYS.has('fleet.job.rule')).toBe(false);
  });
});
