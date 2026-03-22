export interface IPrincipal {
  id: string;
  name: string;
  blacklisted: boolean;
  revoked: boolean;
  authorities: string[];
  extra?: Record<string, unknown>;
}
