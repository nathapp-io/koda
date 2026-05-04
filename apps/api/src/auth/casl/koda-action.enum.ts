export const KodaAction = {
  CREATE: 'create',
  READ: 'read',
  UPDATE: 'update',
  DELETE: 'delete',
  MANAGE: 'manage',
  ASSIGN: 'assign',
  TRANSITION: 'transition',
  ROTATE_KEY: 'rotateKey',
} as const;
export type KodaAction = (typeof KodaAction)[keyof typeof KodaAction];

export type KodaSubject =
  | 'Comment'
  | 'Label'
  | 'Ticket'
  | 'Project'
  | 'Agent'
  | 'AgentScope'
  | 'AdminScope'
  | 'all';
