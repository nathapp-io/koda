import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { AddDocumentDto } from './add-document.dto';

describe('AddDocumentDto — graphify-kb-cc source extension', () => {
  const validBase = {
    sourceId: 'some-id',
    content: 'some content',
  };

  // AC2: source: 'code' must pass class-validator
  it('accepts source "code" without validation errors', async () => {
    const dto = plainToInstance(AddDocumentDto, { ...validBase, source: 'code' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  // Existing sources must still pass after the extension
  it.each(['ticket', 'doc', 'manual'] as const)(
    'still accepts existing source "%s" without validation errors',
    async (source) => {
      const dto = plainToInstance(AddDocumentDto, { ...validBase, source });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    },
  );

  // AC3: source: 'invalid' must fail class-validator
  it('rejects source "invalid" with a validation error on the source field', async () => {
    const dto = plainToInstance(AddDocumentDto, { ...validBase, source: 'invalid' });
    const errors = await validate(dto);
    const sourceErrors = errors.filter((e) => e.property === 'source');
    expect(sourceErrors.length).toBeGreaterThan(0);
  });
});
