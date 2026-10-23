import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateInviteDto } from './create-invite.dto';

/** Mirrors the global ValidationPipe: plainToInstance (transforms) then validate. */
async function check(email: unknown, roleKey: unknown = 'developer') {
  const dto = plainToInstance(CreateInviteDto, { email, roleKey });
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

  /**
   * US-004 (P1l): the legacy `role` field is gone. The DTO ignores it (the global ValidationPipe strips
   * it) and the service answers 400 `invites.roleRequired` when no key arrived.
   */
  it('ignores a legacy role value, whatever it holds', async () => {
    const legacy = plainToInstance(CreateInviteDto, { email: 'dev@example.com', role: 'AGENT' });

    expect(await validate(legacy)).toEqual([]);
  });

  it('roleKey may be absent at the DTO (the service decides), but an explicit null is rejected', async () => {
    const absent = await validate(plainToInstance(CreateInviteDto, { email: 'a@x.io' }));
    const nullRole = await validate(plainToInstance(CreateInviteDto, { email: 'a@x.io', role: null }));
    const nullKey = await validate(plainToInstance(CreateInviteDto, { email: 'a@x.io', roleKey: null }));

    expect(absent).toEqual([]);
    // A legacy `role` is not a declared property any more, so a null one is nothing to validate.
    expect(nullRole.map((error) => error.property)).toEqual([]);
    expect(nullKey.map((error) => error.property)).toEqual(['roleKey']);
  });
});
