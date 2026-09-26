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
});
