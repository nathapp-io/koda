import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateUserDto } from './create-user.dto';
import { UpdateUserDto } from './update-user.dto';
import { ListUsersQuery } from './list-users.query';
import { parseQuery } from '../../common/dto/koda-page.query';

const errorsOf = async (cls: new () => object, raw: object) =>
  (await validate(plainToInstance(cls, raw))).map((e) => e.property);

/**
 * What the global ValidationPipe does to a body: `whitelist: true` without `forbidNonWhitelisted`
 * deletes every property the DTO does not declare. The case for each removed legacy field runs this
 * so the assertion is the pipe's behaviour, not a re-reading of the DTO source.
 */
const strippedByPipe = async (cls: new () => object, raw: object): Promise<object> => {
  const instance = plainToInstance(cls, raw);
  await validate(instance, { whitelist: true });
  return instance;
};

describe('user admin DTOs', () => {
  it('CreateUserDto accepts a valid user and rejects weak passwords and a bad email', async () => {
    const ok = { email: 'a@koda.test', name: 'A', password: 'Admin1234!Aa' };
    expect(await errorsOf(CreateUserDto, ok)).toEqual([]);
    expect(await errorsOf(CreateUserDto, { ...ok, password: 'short' })).toContain('password');
    expect(await errorsOf(CreateUserDto, { ...ok, email: 'nope' })).toContain('email');
  });

  it('US-005: CreateUserDto has no role, so a legacy role is stripped by the pipe instead of validated', async () => {
    const ok = { email: 'a@koda.test', name: 'A', password: 'Admin1234!Aa' };

    // Whatever a legacy client sends never reaches the service: the field is not on the DTO, so the
    // pipe deletes it and even an unparseable value passes.
    expect(await strippedByPipe(CreateUserDto, { ...ok, role: 'ADMIN' })).not.toHaveProperty('role');
    expect(await errorsOf(CreateUserDto, { ...ok, role: 'OWNER' })).toEqual([]);
  });

  it('US-005: UpdateUserDto allows an empty patch, rejects a non-boolean disabled and has no role', async () => {
    expect(await errorsOf(UpdateUserDto, {})).toEqual([]);
    expect(await errorsOf(UpdateUserDto, { disabled: 'yes' })).toContain('disabled');
    // `disabled` is the only patch field; a legacy role is stripped rather than validated.
    expect(await strippedByPipe(UpdateUserDto, { disabled: true, role: 'ADMIN' })).toEqual({ disabled: true });
  });

  it('ListUsersQuery parses paging and keeps the email filter', () => {
    expect(parseQuery(ListUsersQuery, { current: '2', size: '5', email: 'bob' }))
      .toEqual(expect.objectContaining({ current: 2, size: 5, email: 'bob' }));
  });
});
