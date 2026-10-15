import { ProjectResponseDto } from './project-response.dto';

/**
 * US-001 (fleet S5b knowledge core): every project response carries the curated
 * brief. `from` maps fields one by one, so a brief that is not listed there is
 * dropped from every project payload the API returns.
 */
describe('ProjectResponseDto.from — brief (US-001)', () => {
  const project = {
    id: 'proj-1',
    name: 'Koda',
    slug: 'koda',
    key: 'KODA',
    description: 'Fleet platform',
    gitRemoteUrl: 'https://github.com/nathapp-io/koda',
    autoIndexOnClose: true,
    autoAssign: 'OFF',
    graphifyEnabled: false,
    graphifyLastImportedAt: null,
    ciWebhookToken: 'must-not-leak',
    deletedAt: null,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    updatedAt: new Date('2026-10-01T00:00:00.000Z'),
  };

  it('AC-8: maps a brief of "abc" onto the response', () => {
    const dto = ProjectResponseDto.from({ ...project, brief: 'abc' });

    expect(dto.brief).toBe('abc');
  });

  it('AC-9: maps a null brief as null', () => {
    const dto = ProjectResponseDto.from({ ...project, brief: null });

    expect(dto.brief).toBeNull();
  });

  it('keeps the sibling fields and never leaks the project secret', () => {
    const dto = ProjectResponseDto.from({ ...project, brief: 'abc' });

    expect(dto).toMatchObject({ id: 'proj-1', slug: 'koda', key: 'KODA', description: 'Fleet platform' });
    expect(JSON.stringify(dto)).not.toContain('must-not-leak');
  });
});
