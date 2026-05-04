// Mirrors AGENT_ROLES in apps/api/src/common/enums.ts. Keep in sync.
export const AGENT_ROLES = ['DEVELOPER', 'REVIEWER', 'VERIFIER', 'TRIAGER'] as const
export type AgentRole = typeof AGENT_ROLES[number]
