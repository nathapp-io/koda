import { socketHasBacklog } from './socket-backlog';

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
