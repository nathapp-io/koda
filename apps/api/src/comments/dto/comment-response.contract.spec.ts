import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('comment response OpenAPI contract', () => {
  it('publishes RULING as a response type, but not a generic create type', () => {
    const spec = JSON.parse(readFileSync(resolve(__dirname, '../../../../../openapi.json'), 'utf8'));
    expect(spec.components.schemas.CommentResponseDto?.properties.type.enum).toContain('RULING');
    expect(spec.components.schemas.CreateCommentDto.properties.type.enum).toEqual(['GENERAL']);
  });
});
