import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListAuditQuery } from './list-audit.query';
import { parseQuery } from '../../common/dto/koda-page.query';

describe('ListAuditQuery', () => {
  it.each([
    ['AC-10', { from: 'yesterday' }],
    ['AC-11', { from: '2026-10-24T10:00:00' }],
    ['AC-12', { from: '2026-10-24T10:00:00+08:00' }],
    ['AC-13', { actorType: 'ROBOT' }],
    ['invalid calendar day', { to: '2026-02-30' }],
    ['invalid end zone', { to: '2026-10-24T10:00:00' }],
    ['page bound', { size: '101' }],
    ['page origin', { current: '0' }],
  ])('%s: rejects invalid input', async (_name, raw) => {
    expect(await validate(plainToInstance(ListAuditQuery, raw))).not.toHaveLength(0);
  });
  it.each(['key', 'actorId', 'approverId', 'projectId', 'resourceType', 'resourceId'])('bounds and types %s', async (field) => {
    expect(await validate(plainToInstance(ListAuditQuery, { [field]: 'x'.repeat(129) }))).not.toHaveLength(0);
    expect(await validate(plainToInstance(ListAuditQuery, { [field]: 7 }))).not.toHaveLength(0);
  });
  it.each(['2026-10-24', '2026-10-24T10:00:00Z', '2026-10-24T10:00:00.123Z'])('accepts UTC boundary %s and passes all filters', async (date) => {
    const raw = { actorType: 'AGENT', key: 'ticket.create', actorId: 'a1', approverId: 'u1', projectId: 'p1', resourceType: 'ticket', resourceId: 't1', from: date, to: date };
    const parsed = parseQuery(ListAuditQuery, { ...raw, origin: 'rest' });
    expect(await validate(parsed)).toHaveLength(0);
    expect(parsed).toMatchObject({ ...raw, current: 1, size: 20 });
    expect(parsed).not.toHaveProperty('origin');
  });
});
