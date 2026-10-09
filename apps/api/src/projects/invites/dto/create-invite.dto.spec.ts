import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateInviteDto } from './create-invite.dto';

/** Mirrors the global ValidationPipe: plainToInstance (transforms) then validate. */
async function check(email: unknown, role: unknown = 'DEVELOPER') {
  const dto = plainToInstance(CreateInviteDto, { email, role });
  const errors = await validate(dto);
  return {
    email: dto.email,
    failed: errors.map((error) => ({ property: error.property, rules: Object.keys(error.constraints ?? {}) })),
  };
}

describe('CreateInviteDto (S4b US-004)', () => {
  it("AC-3: accepts and normalises a whitespace-padded address (' New@X.io ')", async () => {
    const { email, failed } = await check(' New@X.io ');

    expect(failed).toEqual([]);
    expect(email).toBe('New@X.io');
  });

  it.each([
    ['New@X.io ', 'New@X.io'],
    [' New@X.io', 'New@X.io'],
    ['\tnew@x.io\n', 'new@x.io'],
  ])('trims %j before validation', async (padded, trimmed) => {
    const { email, failed } = await check(padded);

    expect(failed).toEqual([]);
    expect(email).toBe(trimmed);
  });

  it('still rejects an address that is not an email once trimmed', async () => {
    const { failed } = await check(' not-an-email ');

    expect(failed).toEqual([{ property: 'email', rules: ['isEmail'] }]);
  });

  it('rejects a role outside ADMIN | DEVELOPER | VIEWER (including AGENT)', async () => {
    expect((await check('dev@example.com', 'AGENT')).failed).toEqual([
      { property: 'role', rules: ['isIn'] },
    ]);
  });
});
