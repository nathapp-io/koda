import { validate } from 'class-validator';
import { CreateCommentDto } from './create-comment.dto';

describe('CreateCommentDto', () => {
  async function validateType(type?: string) {
    const dto = Object.assign(new CreateCommentDto(), { body: 'Comment body', ...(type === undefined ? {} : { type }) });
    return validate(dto);
  }

  it('AC-1: accepts GENERAL', async () => {
    expect(await validateType('GENERAL')).toEqual([]);
  });

  it('AC-2: accepts an omitted type', async () => {
    expect(await validateType()).toEqual([]);
  });

  it.each(['FIX_REPORT', 'STATUS_CHANGE'])('rejects workflow type %s on type', async (type) => {
    const errors = await validateType(type);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.property).toBe('type');
  });
});
