import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { RetireNoteDto } from './retire-note.dto';

/** The properties `class-validator` refuses on a body parsed as `RetireNoteDto`. */
const errorsFor = async (raw: object): Promise<string[]> =>
  (await validate(plainToInstance(RetireNoteDto, raw))).map((error) => error.property);

describe('RetireNoteDto (memory-notes US-011)', () => {
  it('AC-14: a 501-character reason fails validation on reason', async () => {
    expect(await errorsFor({ reason: 'x'.repeat(501) })).toContain('reason');
  });

  it('AC-14: a 500-character reason and an omitted reason both validate', async () => {
    expect(await errorsFor({ reason: 'x'.repeat(500) })).toEqual([]);
    expect(await errorsFor({})).toEqual([]);
  });

  it('AC-8: a projectId is accepted — a user note names the project that authorises its retire', async () => {
    expect(await errorsFor({ projectId: 'project-1' })).toEqual([]);
  });

  it('AC-14: the body is the same shape as a decision retire — a non-string reason is refused', async () => {
    expect(await errorsFor({ reason: 42 })).toContain('reason');
    expect(await errorsFor({ projectId: 42 })).toContain('projectId');
  });
});
