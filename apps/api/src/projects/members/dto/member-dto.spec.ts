import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { AddMemberDto } from './add-member.dto';
import { UpdateMemberRoleDto } from './update-member-role.dto';

const errorsOf = async (cls: new () => object, raw: object) =>
  (await validate(plainToInstance(cls, raw))).map((e) => e.property);

describe('member DTOs', () => {
  it('AddMemberDto needs an email and an assignable role', async () => {
    // NB: 'a@k.t' from the draft brief fails IsEmail (single-char TLD), so a
    // realistic two-label TLD is used for the valid case.
    expect(await errorsOf(AddMemberDto, { email: 'a@koda.test', role: 'DEVELOPER' })).toEqual([]);
    expect(await errorsOf(AddMemberDto, { email: 'a@koda.test', role: 'AGENT' })).toContain('role');
    expect(await errorsOf(AddMemberDto, { email: 'nope', role: 'VIEWER' })).toContain('email');
  });

  it('UpdateMemberRoleDto accepts ADMIN | DEVELOPER | VIEWER only', async () => {
    for (const role of ['ADMIN', 'DEVELOPER', 'VIEWER']) {
      expect(await errorsOf(UpdateMemberRoleDto, { role })).toEqual([]);
    }
    expect(await errorsOf(UpdateMemberRoleDto, { role: 'MEMBER' })).toContain('role');
    expect(await errorsOf(UpdateMemberRoleDto, {})).toContain('role');
  });

  /**
   * US-004: `roleKey` is the new way to name the granted role and the legacy `role` stays for the CLI.
   * Both are optional, so at most one may be sent — that is the service's `members.roleAndRoleKey` 400,
   * not a DTO shape error, because the DTO cannot express "at most one of two".
   */
  it('AddMemberDto accepts a role key, a legacy role, both, or neither', async () => {
    expect(await errorsOf(AddMemberDto, { email: 'a@koda.test', roleKey: 'triager' })).toEqual([]);
    expect(await errorsOf(AddMemberDto, { email: 'a@koda.test' })).toEqual([]);
    expect(await errorsOf(AddMemberDto, { email: 'a@koda.test', role: 'DEVELOPER', roleKey: 'developer' })).toEqual([]);
  });

  it('AddMemberDto refuses a role key outside the key grammar', async () => {
    // A key must be kebab-case; the property name is what fails, so the field is really validated.
    expect(await errorsOf(AddMemberDto, { email: 'a@koda.test', roleKey: 'Not A Key' })).toContain('roleKey');
    expect(await errorsOf(AddMemberDto, { email: 'a@koda.test', roleKey: 'A' })).toContain('roleKey');
    expect(await errorsOf(AddMemberDto, { email: 'a@koda.test', roleKey: 'custom_role' })).toContain('roleKey');
  });
});
