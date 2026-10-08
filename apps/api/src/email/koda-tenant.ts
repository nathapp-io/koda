/**
 * Fleet S4b D523: koda is single-tenant. Every nestjs-notify row and call uses this id. A multi-tenant koda replaces
 * the call sites with `tenantContext.getTenantId()` after a guard runs `tenantContext.run(tenant)`.
 */
export const KODA_TENANT_ID = 'default';
