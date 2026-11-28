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

  // koda #538: the api runs under Bun in production, where an HTTP response buffers its own writes and the
  // socket's writableLength stays 0. The response is then the only place the backlog is visible.
  it('#538: reads unsent bytes from the response when the socket reports none', () => {
    const req = { raw: { socket: { writableLength: 0 } } };
    expect(socketHasBacklog(req, { writableLength: 10 })()).toBe(true);
  });

  it('#538: still reports a socket backlog when the response has drained', () => {
    const req = { raw: { socket: { writableLength: 10 } } };
    expect(socketHasBacklog(req, { writableLength: 0 })()).toBe(true);
  });

  it('#538: reports no backlog when neither the response nor the socket has unsent bytes', () => {
    const req = { raw: { socket: { writableLength: 0 } } };
    expect(socketHasBacklog(req, { writableLength: 0 })()).toBe(false);
  });

  it('#538: reads the response on every call', () => {
    const response = { writableLength: 0 };
    const hasBacklog = socketHasBacklog({ raw: { socket: { writableLength: 0 } } }, response);
    expect(hasBacklog()).toBe(false);
    response.writableLength = 12_500_000;
    expect(hasBacklog()).toBe(true);
  });

  it('#538: ignores a response whose writableLength is not a number', () => {
    const req = { raw: { socket: { writableLength: 0 } } };
    expect(socketHasBacklog(req, { writableLength: '10' })()).toBe(false);
    expect(socketHasBacklog(req, null)()).toBe(false);
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
