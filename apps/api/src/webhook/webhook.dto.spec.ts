import { validate } from 'class-validator';
import { CreateWebhookDto, UpdateWebhookDto } from './webhook.dto';

/** Mirrors `@MaxLength(2048)` on both DTO url fields. */
const MAX_URL_LENGTH = 2048;

function urlOfLength(length: number): string {
  const prefix = 'https://example.com/';
  return `${prefix}${'a'.repeat(length - prefix.length)}`;
}

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

/**
 * US-003: `url` is a plain string of at most 2048 characters on both DTOs.
 *
 * URL semantics (scheme, credentials, resolved destination, allow-list) belong to
 * `OutboundUrlGuard`, so the DTO must not apply `@IsUrl`'s TLD rule — an allow-listed
 * `localhost` destination is a valid registration.
 */
describe('Webhook DTO url validation (US-003)', () => {
  it('US-003: accepts a create url without a TLD (allow-listed localhost)', async () => {
    const dto = new CreateWebhookDto();
    dto.url = 'https://localhost:3000/hook';
    dto.events = ['STATUS_CHANGE'];

    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('US-003: accepts an update url without a TLD (allow-listed localhost)', async () => {
    const dto = new UpdateWebhookDto();
    dto.url = 'https://localhost:3000/hook';

    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it(`US-003: accepts a create url of exactly ${MAX_URL_LENGTH} characters`, async () => {
    const dto = new CreateWebhookDto();
    dto.url = urlOfLength(MAX_URL_LENGTH);
    dto.events = ['STATUS_CHANGE'];

    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it(`US-003: rejects a create url longer than ${MAX_URL_LENGTH} characters`, async () => {
    const dto = new CreateWebhookDto();
    dto.url = urlOfLength(MAX_URL_LENGTH + 1);
    dto.events = ['STATUS_CHANGE'];

    const errors = await validate(dto);
    const urlError = errors.find((error) => error.property === 'url');
    expect(urlError?.constraints).toHaveProperty('maxLength');
  });

  it(`US-003: rejects an update url longer than ${MAX_URL_LENGTH} characters`, async () => {
    const dto = new UpdateWebhookDto();
    dto.url = urlOfLength(MAX_URL_LENGTH + 1);

    const errors = await validate(dto);
    const urlError = errors.find((error) => error.property === 'url');
    expect(urlError?.constraints).toHaveProperty('maxLength');
  });

  it('US-003: rejects a create url that is not a string', async () => {
    const dto = Object.assign(new CreateWebhookDto(), { url: 42, events: ['STATUS_CHANGE'] });

    const errors = await validate(dto);
    const urlError = errors.find((error) => error.property === 'url');
    expect(urlError?.constraints).toHaveProperty('isString');
  });
});
