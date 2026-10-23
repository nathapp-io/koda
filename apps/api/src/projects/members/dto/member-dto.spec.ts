import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { AddMemberDto } from './add-member.dto';

const errorsOf = async (cls: new () => object, raw: object) =>
  (await validate(plainToInstance(cls, raw))).map((e) => e.property);

describe('member DTOs', () => {
  it('AddMemberDto needs an email and an optional role key', async () => {
    // NB: 'a@k.t' from the draft brief fails IsEmail (single-char TLD), so a
    // realistic two-label TLD is used for the valid case.
    expect(await errorsOf(AddMemberDto, { email: 'a@koda.test', roleKey: 'developer' })).toEqual([]);
    expect(await errorsOf(AddMemberDto, { email: 'nope', roleKey: 'viewer' })).toContain('email');
  });

  /**
   * US-004 (P1l): `roleKey` is the only role field. The legacy `role` is not declared any more, so the
   * DTO validates nothing about it — the global ValidationPipe strips it before the service defaults the
   * grant to `viewer`.
   */
  it('AddMemberDto ignores a legacy role value: it is stripped, not validated', async () => {
    expect(await errorsOf(AddMemberDto, { email: 'a@koda.test', role: 'ADMIN' })).toEqual([]);
    expect(await errorsOf(AddMemberDto, { email: 'a@koda.test', role: 'AGENT' })).toEqual([]);
    expect(await errorsOf(AddMemberDto, { email: 'a@koda.test', role: 'DEVELOPER', roleKey: 'developer' })).toEqual([]);
  });

  it('AddMemberDto accepts an absent role key — the service defaults it to viewer', async () => {
    expect(await errorsOf(AddMemberDto, { email: 'a@koda.test' })).toEqual([]);
  });

  /**
   * An explicit `null` is the one role-key shape the DTO refuses: `@ValidateIf` runs the pattern check
   * for any present value, where the old `@IsOptional` would have skipped `null`.
   */
  it('AddMemberDto refuses an explicit null role key', async () => {
    expect(await errorsOf(AddMemberDto, { email: 'a@koda.test', roleKey: null })).toEqual(['roleKey']);
  });

  it('AddMemberDto refuses a role key outside the key grammar', async () => {
    // A key must be kebab-case; the property name is what fails, so the field is really validated.
    expect(await errorsOf(AddMemberDto, { email: 'a@koda.test', roleKey: 'Not A Key' })).toContain('roleKey');
    expect(await errorsOf(AddMemberDto, { email: 'a@koda.test', roleKey: 'A' })).toContain('roleKey');
    expect(await errorsOf(AddMemberDto, { email: 'a@koda.test', roleKey: 'custom_role' })).toContain('roleKey');
  });
});
