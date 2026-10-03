import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DispatchFleetJobDto } from './dispatch-fleet-job.dto';

describe('DispatchFleetJobDto', () => {
  const dto = (over: Record<string, unknown> = {}): Record<string, unknown> =>
    ({ repoId: 'r', command: 'RUN', feature: 'f', maxCostUsd: 1, ...over });

  it.each([[29], [3601], [1.5]])('refuses approvalTimeoutSec %p', async (approvalTimeoutSec) => {
    const errors = await validate(plainToInstance(DispatchFleetJobDto, dto({ approvalTimeoutSec })));
    expect(errors.map((e) => e.property)).toContain('approvalTimeoutSec');
  });
  it('refuses an unknown bashMode', async () => {
    const errors = await validate(plainToInstance(DispatchFleetJobDto, dto({ bashMode: 'yolo' })));
    expect(errors.map((e) => e.property)).toContain('bashMode');
  });
});
