import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { UpdateProjectDto } from './update-project.dto';

describe('UpdateProjectDto', () => {
  it('accepts ciWebhookToken with length >= 32', async () => {
    const dto = plainToInstance(UpdateProjectDto, {
      ciWebhookToken: '12345678901234567890123456789012',
    });

    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects ciWebhookToken shorter than 32 chars', async () => {
    const dto = plainToInstance(UpdateProjectDto, {
      ciWebhookToken: 'short-token',
    });

    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    const ciTokenError = errors.find((error) => error.property === 'ciWebhookToken');
    expect(ciTokenError?.constraints).toHaveProperty('minLength');
  });

  /**
   * US-001 (fleet S5b): `brief` is a nullable string of at most 3000 characters.
   * The e2e suite covers the same rules through the route; these pin the pipe
   * contract (the global ValidationPipe runs with `whitelist: true`, so an
   * undeclared `brief` would be stripped instead of rejected).
   */
  describe('brief (US-001)', () => {
    it('accepts a brief of exactly 3000 characters', async () => {
      const dto = plainToInstance(UpdateProjectDto, { brief: 'k'.repeat(3000) });

      expect(await validate(dto)).toHaveLength(0);
    });

    it('rejects a brief of 3001 characters with the maxLength constraint', async () => {
      const dto = plainToInstance(UpdateProjectDto, { brief: 'k'.repeat(3001) });

      const errors = await validate(dto);
      const briefError = errors.find((error) => error.property === 'brief');
      expect(briefError?.constraints).toHaveProperty('maxLength');
    });

    it('rejects a non-string brief with the isString constraint', async () => {
      const dto = plainToInstance(UpdateProjectDto, { brief: 42 });

      const errors = await validate(dto);
      const briefError = errors.find((error) => error.property === 'brief');
      expect(briefError?.constraints).toHaveProperty('isString');
    });

    it('accepts null (clear the brief) and an empty string (stored as given)', async () => {
      expect(await validate(plainToInstance(UpdateProjectDto, { brief: null }))).toHaveLength(0);
      expect(await validate(plainToInstance(UpdateProjectDto, { brief: '' }))).toHaveLength(0);
    });

    it('keeps accepting an update that omits the brief', async () => {
      expect(await validate(plainToInstance(UpdateProjectDto, { description: 'x' }))).toHaveLength(0);
    });
  });
});
