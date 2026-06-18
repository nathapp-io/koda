import { validate } from 'class-validator';
import { RegisterDto } from './register.dto';

describe('RegisterDto', () => {
  it('accepts a strong password', async () => {
    const dto = new RegisterDto();
    dto.email = 'user@example.com';
    dto.name = 'User';
    dto.password = 'StrongPass123!';

    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects passwords shorter than 8 characters', async () => {
    const dto = new RegisterDto();
    dto.email = 'user@example.com';
    dto.name = 'User';
    dto.password = 'Ab1!xyz';

    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    const passwordError = errors.find((error) => error.property === 'password');
    expect(passwordError?.constraints).toHaveProperty('minLength');
  });

  it('rejects passwords missing required complexity', async () => {
    const dto = new RegisterDto();
    dto.email = 'user@example.com';
    dto.name = 'User';
    dto.password = 'Strongpass1234';

    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    const passwordError = errors.find((error) => error.property === 'password');
    expect(passwordError?.constraints).toHaveProperty('matches');
  });
});
