import { isLogStream, isUploadStream, UPLOAD_STREAMS } from './fleet-job-log.domain';

describe('fleet job log stream names', () => {
  it('US-001 AC2: isLogStream("thread") is false; the readable streams stay run, stdout and stderr', () => {
    expect(isLogStream('thread')).toBe(false);
    expect(['run', 'stdout', 'stderr'].map((s) => isLogStream(s))).toEqual([true, true, true]);
  });

  it('US-001: isUploadStream accepts the readable streams and thread, and nothing else', () => {
    expect(UPLOAD_STREAMS).toEqual(['run', 'stdout', 'stderr', 'thread']);
    expect(isUploadStream('thread')).toBe(true);
    expect(isUploadStream('run')).toBe(true);
    expect(isUploadStream('prompt')).toBe(false);
    expect(isUploadStream('')).toBe(false);
    expect(isUploadStream(undefined)).toBe(false);
    expect(isUploadStream(1)).toBe(false);
  });
});
