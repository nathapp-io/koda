import { validate } from 'class-validator';
import { AddDocumentDto } from './add-document.dto';

describe('AddDocumentDto sourceId reserved prefixes', () => {
  it.each(['repo:r1:docs/a.md', 'outcome:r1:j1:report'])('rejects reserved id %s on sourceId', async (sourceId) => {
    const dto = Object.assign(new AddDocumentDto(), { source: 'doc', sourceId, content: 'x' });

    const errors = await validate(dto);

    expect(errors.map((error) => ({ property: error.property, messages: Object.values(error.constraints ?? {}) }))).toContainEqual({
      property: 'sourceId',
      messages: expect.arrayContaining(['sourceId must not start with a reserved prefix (repo:, outcome:)']),
    });
  });

  it('allows reserved words anywhere except the start of sourceId', async () => {
    const dto = Object.assign(new AddDocumentDto(), { source: 'doc', sourceId: 'notes:repo:x', content: 'x' });

    await expect(validate(dto)).resolves.toEqual([]);
  });
});
