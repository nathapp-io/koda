import { validate } from 'class-validator';
import { UpdateRunnerDto } from './update-runner.dto';

async function errorProps(raw: object): Promise<string[]> {
  const dto = Object.assign(new UpdateRunnerDto(), raw);
  return (await validate(dto)).map((e) => e.property);
}

describe('UpdateRunnerDto threadCapacity', () => {
  it.each([0, 3, 16])('accepts threadCapacity %i (US-002 AC5, AC6)', async (threadCapacity) => {
    expect(await errorProps({ threadCapacity })).toEqual([]);
  });

  it.each([
    [17, 'above 16 (US-002 AC7)'],
    [-1, 'negative'],
    [1.5, 'not an integer'],
  ])('rejects threadCapacity %s (%s)', async (threadCapacity) => {
    expect(await errorProps({ threadCapacity })).toContain('threadCapacity');
  });
});
