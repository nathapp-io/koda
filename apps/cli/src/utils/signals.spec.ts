import { EventEmitter } from 'events';
import { EXIT_SIGINT, EXIT_SIGTERM, installSignalHandlers } from './signals';

function fakeProcess() {
  const emitter = new EventEmitter();
  const exit = jest.fn();
  return { target: { on: emitter.on.bind(emitter), exit: exit as unknown as (code: number) => never }, emitter, exit };
}

describe('installSignalHandlers', () => {
  it('exits 130 on SIGINT (Ctrl+C)', () => {
    const { target, emitter, exit } = fakeProcess();
    const log = jest.fn();
    installSignalHandlers(target, log);
    emitter.emit('SIGINT');
    expect(EXIT_SIGINT).toBe(130);
    expect(exit).toHaveBeenCalledWith(130);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Interrupted'));
  });

  it('exits 143 on SIGTERM', () => {
    const { target, emitter, exit } = fakeProcess();
    installSignalHandlers(target, jest.fn());
    emitter.emit('SIGTERM');
    expect(EXIT_SIGTERM).toBe(143);
    expect(exit).toHaveBeenCalledWith(143);
  });
});
