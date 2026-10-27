import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { PERMISSION_CATALOG, PENDING_SURFACE_KEYS } from '../permissions/catalog';
import { InvalidApprovalPolicyError } from './domain/approval.errors';
import { toPolicySubject } from './dto/approval-policy-subject.dto';
import { CreateApprovalPolicyDto } from './dto/approval-policy.dto';
import { approvableKeys } from './approvable-keys';

describe('Approval policy HTTP contracts', () => {
  it('AC-9: type without principalType is a subject violation', () => {
    expect(() => toPolicySubject({ kind: 'type' })).toThrow(InvalidApprovalPolicyError);
    try { toPolicySubject({ kind: 'type' }); } catch (error) { expect(error).toHaveProperty('violation', 'subject'); }
  });
  it('AC-10: assistant cannot be a principal subject', () => {
    expect(() => toPolicySubject({ kind: 'principal', principalType: 'ASSISTANT', principalId: 'x' })).toThrow(InvalidApprovalPolicyError);
    try { toPolicySubject({ kind: 'principal', principalType: 'ASSISTANT', principalId: 'x' }); } catch (error) { expect(error).toHaveProperty('violation', 'subject'); }
  });
  it('AC-11: role subject preserves its role id', () => {
    expect(toPolicySubject({ kind: 'role', roleId: 'r1' })).toEqual({ kind: 'role', roleId: 'r1' });
  });
  it('converts all, type and principal subjects', () => {
    expect(toPolicySubject({ kind: 'all' })).toEqual({ kind: 'all' });
    expect(toPolicySubject({ kind: 'type', principalType: 'ASSISTANT' })).toEqual({ kind: 'type', principalType: 'ASSISTANT' });
    expect(toPolicySubject({ kind: 'principal', principalType: 'USER', principalId: 'u' })).toEqual({ kind: 'principal', principalType: 'USER', principalId: 'u' });
    expect(() => toPolicySubject({ kind: 'role' })).toThrow(InvalidApprovalPolicyError);
  });
  it('AC-8: nested bogus subject fails DTO validation', () => {
    expect(validateSync(plainToInstance(CreateApprovalPolicyDto, { permissionPattern: 'label.delete', appliesTo: { kind: 'bogus' }, mode: 'human' }))).not.toHaveLength(0);
  });
  it('AC-13: policy manage is no longer pending', () => {
    expect(PENDING_SURFACE_KEYS.has('approval.policy.manage')).toBe(false);
  });
  it('AC-14: keys exactly match sorted approvable catalog metadata', () => {
    const expected = PERMISSION_CATALOG.filter((entry) => entry.approval.approvable).map(({ key, scope, risk, approval }) => ({ key, scope, risk, floor: approval.floor, default: approval.default })).sort((a, b) => a.key.localeCompare(b.key));
    expect(approvableKeys()).toEqual(expected);
    expect(approvableKeys().length).toBeGreaterThan(0);
  });
});
