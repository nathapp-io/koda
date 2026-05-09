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
});
