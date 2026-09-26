import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateUserDto } from './create-user.dto';
import { UpdateUserDto } from './update-user.dto';
import { ListUsersQuery } from './list-users.query';
import { parseQuery } from '../../common/dto/koda-page.query';

const errorsOf = async (cls: new () => object, raw: object) =>
  (await validate(plainToInstance(cls, raw))).map((e) => e.property);

describe('user admin DTOs', () => {
  it('CreateUserDto accepts a valid user and rejects weak passwords and unknown roles', async () => {
    const ok = { email: 'a@koda.test', name: 'A', password: 'Admin1234!Aa', role: 'MEMBER' };
    expect(await errorsOf(CreateUserDto, ok)).toEqual([]);
    expect(await errorsOf(CreateUserDto, { ...ok, password: 'short' })).toContain('password');
    expect(await errorsOf(CreateUserDto, { ...ok, role: 'OWNER' })).toContain('role');
    expect(await errorsOf(CreateUserDto, { ...ok, email: 'nope' })).toContain('email');
  });

  it('UpdateUserDto allows an empty patch and rejects non-boolean disabled', async () => {
    expect(await errorsOf(UpdateUserDto, {})).toEqual([]);
    expect(await errorsOf(UpdateUserDto, { disabled: 'yes' })).toContain('disabled');
    expect(await errorsOf(UpdateUserDto, { role: 'VIEWER' })).toContain('role');
  });

  it('ListUsersQuery parses paging and keeps the email filter', () => {
    expect(parseQuery(ListUsersQuery, { current: '2', size: '5', email: 'bob' }))
      .toEqual(expect.objectContaining({ current: 2, size: 5, email: 'bob' }));
  });
});
