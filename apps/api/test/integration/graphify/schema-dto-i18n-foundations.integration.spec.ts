import { readFileSync } from 'fs';
import { join } from 'path';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AddDocumentDto } from '../../../src/rag/dto/add-document.dto';
import { ProjectResponseDto } from '../../../src/projects/dto/project-response.dto';
import { UpdateProjectDto } from '../../../src/projects/dto/update-project.dto';

describe('Graphify foundations: schema, DTO, and i18n contracts', () => {
  it('AC1: Project schema defines graphifyEnabled with default false', () => {
    const schemaPath = join(__dirname, '../../../prisma/schema.prisma');
    const schema = readFileSync(schemaPath, 'utf-8');

    expect(schema).toMatch(/model\s+Project\s+\{[\s\S]*graphifyEnabled\s+Boolean\s+@default\(false\)/);
  });

  it('AC2: AddDocumentDto accepts source="code"', async () => {
    const dto = plainToInstance(AddDocumentDto, {
      source: 'code',
      sourceId: 'ticket_123',
      content: 'function graphify() { return true; }',
      metadata: { language: 'ts' },
    });

    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('AC3: AddDocumentDto rejects source outside [ticket, doc, manual, code]', async () => {
    const dto = plainToInstance(AddDocumentDto, {
      source: 'random',
      sourceId: 'ticket_123',
      content: 'invalid source payload',
      metadata: {},
    });

    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((error) => error.property === 'source')).toBe(true);
  });

  it('AC4: IndexDocumentInput.source includes the "code" literal', () => {
    const ragServicePath = join(__dirname, '../../../src/rag/rag.service.ts');
    const ragServiceSource = readFileSync(ragServicePath, 'utf-8');

    expect(ragServiceSource).toMatch(/source:\s*'ticket'\s*\|\s*'doc'\s*\|\s*'manual'\s*\|\s*'code'/);
  });

  it('AC5 and AC6: ProjectResponseDto.from maps graphifyEnabled and graphifyLastImportedAt', () => {
    const importedAt = new Date('2026-04-10T09:00:00.000Z');
    const dto = ProjectResponseDto.from({
      id: 'proj_1',
      name: 'Graphify',
      slug: 'graphify',
      key: 'GRAF',
      description: null,
      gitRemoteUrl: null,
      autoIndexOnClose: true,
      createdAt: new Date('2026-04-10T08:00:00.000Z'),
      updatedAt: new Date('2026-04-10T08:30:00.000Z'),
      deletedAt: null,
      ciWebhookToken: null,
      autoAssign: 'OFF',
      graphifyEnabled: true,
      graphifyLastImportedAt: importedAt,
    });

    expect(dto).toHaveProperty('graphifyEnabled', true);
    expect(dto).toHaveProperty('graphifyLastImportedAt', importedAt);
  });

  it('AC6: ProjectResponseDto.from keeps graphifyLastImportedAt as null', () => {
    const dto = ProjectResponseDto.from({
      id: 'proj_2',
      name: 'Graphify Null',
      slug: 'graphify-null',
      key: 'GRFN',
      description: null,
      gitRemoteUrl: null,
      autoIndexOnClose: true,
      createdAt: new Date('2026-04-10T08:00:00.000Z'),
      updatedAt: new Date('2026-04-10T08:30:00.000Z'),
      deletedAt: null,
      ciWebhookToken: null,
      autoAssign: 'OFF',
      graphifyEnabled: false,
      graphifyLastImportedAt: null,
    });

    expect(dto).toHaveProperty('graphifyLastImportedAt', null);
  });

  it('AC7: UpdateProjectDto accepts graphifyEnabled=true', async () => {
    const dto = plainToInstance(UpdateProjectDto, {
      graphifyEnabled: true,
    });

    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

    expect(errors).toHaveLength(0);
  });

  it('AC8: rag.graphifyDisabled exists and is non-empty in en and zh locale files', () => {
    const enPath = join(__dirname, '../../../src/i18n/en/rag.json');
    const zhPath = join(__dirname, '../../../src/i18n/zh/rag.json');

    const en = JSON.parse(readFileSync(enPath, 'utf-8')) as Record<string, unknown>;
    const zh = JSON.parse(readFileSync(zhPath, 'utf-8')) as Record<string, unknown>;

    expect(typeof en.graphifyDisabled).toBe('string');
    expect((en.graphifyDisabled as string).trim().length).toBeGreaterThan(0);

    expect(typeof zh.graphifyDisabled).toBe('string');
    expect((zh.graphifyDisabled as string).trim().length).toBeGreaterThan(0);
  });
});
