import { REQUIRES_METADATA } from '../../permissions/requires.decorator';
import { PublicInvitesController } from './public-invites.controller';

describe('US-010 permission keys on the public invite routes', () => {
  it.each([
    ['preview', 'invite.preview'],
    ['accept', 'invite.accept'],
  ] as const)('%s declares @Requires(%s)', (handler, key) => {
    const fn = (PublicInvitesController.prototype as unknown as Record<string, object>)[handler];

    expect(Reflect.getMetadata(REQUIRES_METADATA, fn)).toEqual({
      keys: [key],
      mode: 'all',
      enforcedBy: 'guard',
    });
  });
});

describe('PublicInvitesController', () => {
  const acceptance = {
    preview: vi.fn().mockResolvedValue({ projectSlug: 'p1', email: 'a@k.t', role: 'VIEWER' }),
    accept: vi.fn().mockResolvedValue({ accessToken: 'tok' }),
  };
  const controller = new PublicInvitesController(acceptance as never);

  afterEach(() => vi.clearAllMocks());

  it('preview hands the raw token to the service and wraps the result', async () => {
    const res = await controller.preview('raw-token');

    expect(acceptance.preview).toHaveBeenCalledWith('raw-token');
    expect(res).toEqual(expect.objectContaining({ data: expect.objectContaining({ projectSlug: 'p1' }) }));
  });

  it('accept hands the raw token and the body to the service', async () => {
    const dto = { name: 'New User', password: 'Password123!' };

    await controller.accept('raw-token', dto);

    expect(acceptance.accept).toHaveBeenCalledWith('raw-token', dto);
  });
});
