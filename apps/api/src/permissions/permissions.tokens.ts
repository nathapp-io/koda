/**
 * Permissions P1a: the module's DI tokens.
 *
 * The repositories are module-private (`PermissionsModule` provides them but never exports them), so
 * these symbols are only meaningful inside `apps/api/src/permissions/`. `SYSTEM_ROLES_SEED` is a
 * separate token from the `SYSTEM_ROLES` constant so a test can bootstrap the API with another list.
 */

/** `IRepository<RoleDomain>` — the only code that reads or writes `Role`. */
export const ROLE_REPOSITORY = Symbol('ROLE_REPOSITORY');

/** `IRepository<RoleBindingDomain>` — the only code that reads or writes `RoleBinding`. */
export const ROLE_BINDING_REPOSITORY = Symbol('ROLE_BINDING_REPOSITORY');

/** `readonly RoleSeed[]` — what `SystemRoleSeeder` seeds. `PermissionsModule` binds `SYSTEM_ROLES`. */
export const SYSTEM_ROLES_SEED = Symbol('SYSTEM_ROLES_SEED');
