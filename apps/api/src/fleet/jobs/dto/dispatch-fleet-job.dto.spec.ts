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
  it('rejects a REVIEW with null prNumber on prNumber', async () => {
    const errors = await validate(plainToInstance(DispatchFleetJobDto, dto({ command: 'REVIEW', feature: undefined, prNumber: null })));
    expect(errors.map((e) => e.property)).toContain('prNumber');
  });
  it('rejects a REVIEW with prNumber 0 on prNumber', async () => {
    const errors = await validate(plainToInstance(DispatchFleetJobDto, dto({ command: 'REVIEW', feature: undefined, prNumber: 0 })));
    expect(errors.map((e) => e.property)).toContain('prNumber');
  });
  it('refuses an unknown bashMode', async () => {
    const errors = await validate(plainToInstance(DispatchFleetJobDto, dto({ bashMode: 'yolo' })));
    expect(errors.map((e) => e.property)).toContain('bashMode');
  });
  it('accepts AGENT with a valid nested agent input', async () => {
    const errors = await validate(plainToInstance(DispatchFleetJobDto, dto({ command: 'AGENT', agent: { name: 'spec-reviewer', task: 'Review' } })));
    expect(errors).toEqual([]);
  });
  it.each(['fast model', ' fast', 'fast '])('rejects nested agent model containing whitespace: %p', async (model) => {
    const errors = await validate(plainToInstance(DispatchFleetJobDto, dto({
      command: 'AGENT', agent: { name: 'spec-reviewer', task: 'Review', model },
    })));
    const agentError = errors.find((error) => error.property === 'agent');
    expect(agentError?.children?.find((error) => error.property === 'model')).toBeDefined();
  });
  it('rejects unknown ACP providers in nested model aliases', async () => {
    const errors = await validate(plainToInstance(DispatchFleetJobDto, dto({
      command: 'AGENT', agent: { name: 'spec-reviewer', task: 'Review', modelAliases: { reviewer: 'acp:bogus/model' } },
    })));
    const agentError = errors.find((error) => error.property === 'agent');
    expect(agentError?.children?.find((error) => error.property === 'modelAliases')).toBeDefined();
  });
  it('reports an oversized nested agent task on agent.task', async () => {
    const errors = await validate(plainToInstance(DispatchFleetJobDto, dto({
      command: 'AGENT', agent: { name: 'spec-reviewer', task: 't'.repeat(16_385) },
    })));
    const agentError = errors.find((error) => error.property === 'agent');
    expect(agentError?.children?.find((error) => error.property === 'task')).toBeDefined();
  });
  it('accepts FIX as a command', async () => {
    const errors = await validate(plainToInstance(DispatchFleetJobDto, dto({ command: 'FIX', feature: undefined, prNumber: 7 })));
    expect(errors).toEqual([]);
  });
  it('rejects lowercase fix as a command', async () => {
    const errors = await validate(plainToInstance(DispatchFleetJobDto, dto({ command: 'fix' })));
    expect(errors.find((e) => e.property === 'command')).toBeDefined();
  });
});
