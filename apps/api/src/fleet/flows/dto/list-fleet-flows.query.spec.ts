import { describe, expect, it } from 'vitest';
import { validate } from 'class-validator';
import { ListFleetFlowsQuery } from './list-fleet-flows.query';

describe('ListFleetFlowsQuery', () => {
  it('rejects a threadId longer than 64 characters', async () => {
    const errors = await validate(Object.assign(new ListFleetFlowsQuery(), { threadId: 't'.repeat(65) }));
    expect(errors[0]?.property).toBe('threadId');
    expect(errors[0]?.constraints).toHaveProperty('maxLength');
  });
});
