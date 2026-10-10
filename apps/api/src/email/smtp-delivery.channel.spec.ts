import { PermanentNotificationError } from '@nathapp/nestjs-notify';
import { SmtpDeliveryChannel, smtpEmailProviderFactory } from './smtp-delivery.channel';

const payload = { tenantId: 'default', channel: 'email', templateCode: 'NOTIFICATION', recipient: 'b@x.io' };

describe('SmtpDeliveryChannel (S4b §1)', () => {
  it('sends the rendered subject and html and returns the message id', async () => {
    const provider = { send: vi.fn(async () => ({ success: true, requestId: 'mid-1' })) };
    const channel = new SmtpDeliveryChannel(provider as never);
    await expect(channel.send(payload, '<p>hi</p>', 'Subj')).resolves.toEqual({ providerMessageId: 'mid-1' });
    expect(provider.send).toHaveBeenCalledWith({ recipient: 'b@x.io', subject: 'Subj', message: '<p>hi</p>' });
  });

  it('throws a retryable Error when the provider reports failure', async () => {
    const provider = { send: vi.fn(async () => ({ success: false, message: 'ECONNREFUSED' })) };
    const err = await new SmtpDeliveryChannel(provider as never).send(payload, 'x', 's').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PermanentNotificationError);
    expect((err as Error).message).toContain('ECONNREFUSED');
  });

  it('throws a permanent error for a rejected recipient (SMTP 55x)', async () => {
    const provider = { send: vi.fn(async () => ({ success: false, message: '550 5.1.1 mailbox unavailable' })) };
    await expect(new SmtpDeliveryChannel(provider as never).send(payload, 'x', 's')).rejects.toBeInstanceOf(PermanentNotificationError);
  });

  it('throws a permanent error when email is not configured', async () => {
    await expect(new SmtpDeliveryChannel(null).send(payload, 'x', 's')).rejects.toBeInstanceOf(PermanentNotificationError);
  });

  it('uses an empty subject when the template has none', async () => {
    const provider = { send: vi.fn(async () => ({ success: true })) };
    await new SmtpDeliveryChannel(provider as never).send(payload, 'x');
    expect(provider.send).toHaveBeenCalledWith(expect.objectContaining({ subject: '' }));
  });

  it('factory: a provider construction error never carries the SMTP URL (S4b review I2)', () => {
    const availability = { config: () => ({ smtpUrl: 'smtp://user:s3cret@h:-1', from: 'k@x' }) };
    let thrown: unknown;
    try { smtpEmailProviderFactory(availability as never); } catch (e) { thrown = e; }
    if (thrown) {
      expect(String(thrown)).not.toContain('s3cret');
      expect(JSON.stringify(thrown, Object.getOwnPropertyNames(thrown as object))).not.toContain('s3cret');
    }
  });

  it('factory returns null when email is off', () => {
    expect(smtpEmailProviderFactory({ config: () => ({ smtpUrl: null, from: null }) } as never)).toBeNull();
  });
});
