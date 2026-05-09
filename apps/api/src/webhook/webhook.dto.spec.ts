import { validate } from 'class-validator';
import { CreateWebhookDto, UpdateWebhookDto } from './webhook.dto';

describe('Webhook DTO validation', () => {
  it('accepts create dto with secret length >= 32', async () => {
    const dto = new CreateWebhookDto();
    dto.url = 'https://example.com/webhook';
    dto.secret = '12345678901234567890123456789012';
    dto.events = ['STATUS_CHANGE'];

    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects create dto with secret length < 32', async () => {
    const dto = new CreateWebhookDto();
    dto.url = 'https://example.com/webhook';
    dto.secret = '1234567890123456789012345678901';
    dto.events = ['STATUS_CHANGE'];

    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    const secretError = errors.find((error) => error.property === 'secret');
    expect(secretError?.constraints).toHaveProperty('minLength');
  });

  it('allows update dto when secret is omitted', async () => {
    const dto = new UpdateWebhookDto();
    dto.active = true;

    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects update dto with provided secret length < 32', async () => {
    const dto = new UpdateWebhookDto();
    dto.secret = 'short-secret';

    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    const secretError = errors.find((error) => error.property === 'secret');
    expect(secretError?.constraints).toHaveProperty('minLength');
  });
});
