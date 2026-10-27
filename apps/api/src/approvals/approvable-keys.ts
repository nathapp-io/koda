import { PERMISSION_CATALOG } from '../permissions/catalog';
import type { ApprovableKeyDto } from './dto/approval-policy.dto';

export function approvableKeys(): ApprovableKeyDto[] {
  return PERMISSION_CATALOG.filter(({ approval }) => approval.approvable)
    .map(({ key, scope, risk, approval }) => ({ key, scope, risk, floor: approval.floor, default: approval.default }))
    .sort((a, b) => a.key.localeCompare(b.key));
}
