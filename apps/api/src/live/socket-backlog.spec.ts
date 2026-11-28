import { destroyRequestSocket, socketHasBacklog } from './socket-backlog';

describe('socketHasBacklog', () => {
  it('AC-6: reads backlog from a Fastify raw socket', () => {
    expect(socketHasBacklog({ raw: { socket: { writableLength: 10 } } })()).toBe(true);
  });

  it('AC-7: reads backlog from a plain Node request socket', () => {
    expect(socketHasBacklog({ socket: { writableLength: 10 } })()).toBe(true);
  });

  it('AC-8: reads the socket on every call', () => {
    const socket = { writableLength: 0 };
    const hasBacklog = socketHasBacklog({ raw: { socket } });
    expect(hasBacklog()).toBe(false);
    socket.writableLength = 5;
    expect(hasBacklog()).toBe(true);
  });

  it('AC-9: reports no backlog when no socket is present', () => {
    expect(socketHasBacklog({})()).toBe(false);
  });
});

describe('destroyRequestSocket', () => {
  it('B1: drops the Fastify raw socket of a client that stopped reading', () => {
    const destroy = vi.fn();
    destroyRequestSocket({ raw: { socket: { writableLength: 5, destroy } } });
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('B1: drops a plain Node request socket', () => {
    const destroy = vi.fn();
    destroyRequestSocket({ socket: { destroy } });
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('B1: leaves a request without a destroyable socket alone', () => {
    expect(() => destroyRequestSocket({ raw: { socket: { writableLength: 5 } } })).not.toThrow();
    expect(() => destroyRequestSocket({})).not.toThrow();
    expect(() => destroyRequestSocket(null)).not.toThrow();
  });
});
