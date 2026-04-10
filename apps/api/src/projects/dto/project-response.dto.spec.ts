import { ProjectResponseDto } from './project-response.dto';

describe('ProjectResponseDto.from() — graphify-kb-cc field mapping', () => {
  const baseProject = {
    id: 'proj-1',
    name: 'Test Project',
    slug: 'test-project',
    key: 'TST',
    description: null,
    gitRemoteUrl: null,
    autoIndexOnClose: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    deletedAt: null,
    ciWebhookToken: null,
    autoAssign: 'OFF',
    graphifyEnabled: false,
    graphifyLastImportedAt: null,
  };

  // AC6: graphifyEnabled is mapped as a boolean
  it('maps graphifyEnabled: false to dto.graphifyEnabled as boolean false', () => {
    const dto = ProjectResponseDto.from({ ...baseProject, graphifyEnabled: false });
    expect(typeof dto.graphifyEnabled).toBe('boolean');
    expect(dto.graphifyEnabled).toBe(false);
  });

  it('maps graphifyEnabled: true to dto.graphifyEnabled as boolean true', () => {
    const dto = ProjectResponseDto.from({ ...baseProject, graphifyEnabled: true });
    expect(typeof dto.graphifyEnabled).toBe('boolean');
    expect(dto.graphifyEnabled).toBe(true);
  });

  // AC7: graphifyLastImportedAt is mapped as Date | null
  it('maps graphifyLastImportedAt: null to dto.graphifyLastImportedAt as null', () => {
    const dto = ProjectResponseDto.from({ ...baseProject, graphifyLastImportedAt: null });
    expect(dto.graphifyLastImportedAt).toBeNull();
  });

  it('maps graphifyLastImportedAt: Date to dto.graphifyLastImportedAt as the same Date', () => {
    const importedAt = new Date('2026-04-01T12:00:00Z');
    const dto = ProjectResponseDto.from({ ...baseProject, graphifyLastImportedAt: importedAt });
    expect(dto.graphifyLastImportedAt).toEqual(importedAt);
    expect(dto.graphifyLastImportedAt).toBeInstanceOf(Date);
  });
});
