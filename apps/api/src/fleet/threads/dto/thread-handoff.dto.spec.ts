import { validate } from 'class-validator';
import { RunThreadDto } from './thread-handoff.dto';

function runDto(input: Record<string, unknown>): RunThreadDto {
  return Object.assign(new RunThreadDto(), input);
}

describe('RunThreadDto validation (US-007)', () => {
  it('accepts an empty body (every field is optional)', async () => {
    expect(await validate(runDto({}))).toHaveLength(0);
  });

  it('accepts each bashMode the dispatch form offers', async () => {
    for (const bashMode of ['raw', 'gated', 'escalate']) {
      expect(await validate(runDto({ bashMode }))).toHaveLength(0);
    }
  });

  it('rejects a bashMode outside raw, gated and escalate', async () => {
    const errors = await validate(runDto({ bashMode: 'yolo' }));
    expect(errors.map((e) => e.property)).toEqual(['bashMode']);
  });

  it('rejects more than 8 profiles and profiles longer than 64 characters', async () => {
    expect((await validate(runDto({ profiles: Array.from({ length: 9 }, (_, i) => `p${i}`) }))).map((e) => e.property)).toEqual(['profiles']);
    expect((await validate(runDto({ profiles: ['x'.repeat(65)] }))).map((e) => e.property)).toEqual(['profiles']);
  });

  it('bounds maxCostUsd like the dispatch form: > 0, at most 10000, at most 4 decimals', async () => {
    expect(await validate(runDto({ maxCostUsd: 0.0001 }))).toHaveLength(0);
    expect((await validate(runDto({ maxCostUsd: 0 }))).map((e) => e.property)).toEqual(['maxCostUsd']);
    expect((await validate(runDto({ maxCostUsd: 10_001 }))).map((e) => e.property)).toEqual(['maxCostUsd']);
    expect((await validate(runDto({ maxCostUsd: 1.00001 }))).map((e) => e.property)).toEqual(['maxCostUsd']);
  });
});
