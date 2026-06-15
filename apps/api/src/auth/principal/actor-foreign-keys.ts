import { KodaPrincipal, isUserPrincipal } from './koda-principal.types';

const getFieldNames = (prefix: 'createdBy' | 'authoredBy' | 'assignedTo' | 'actor') => {
  if (prefix === 'actor') {
    return { userField: 'actorUserId', agentField: 'actorAgentId' };
  }
  if (prefix === 'authoredBy') {
    return { userField: 'authorUserId', agentField: 'authorAgentId' };
  }
  return {
    userField: `${prefix}UserId`,
    agentField: `${prefix}AgentId`,
  };
};

export function actorForeignKeys(
  principal: KodaPrincipal,
  prefix: 'createdBy',
): { createdByUserId: string | null; createdByAgentId: string | null };
export function actorForeignKeys(
  principal: KodaPrincipal,
  prefix: 'authoredBy',
): { authorUserId: string | null; authorAgentId: string | null };
export function actorForeignKeys(
  principal: KodaPrincipal,
  prefix: 'assignedTo',
): { assignedToUserId: string | null; assignedToAgentId: string | null };
export function actorForeignKeys(
  principal: KodaPrincipal,
  prefix: 'actor',
): { actorUserId: string | null; actorAgentId: string | null };
export function actorForeignKeys(
  principal: KodaPrincipal,
  prefix: 'createdBy' | 'authoredBy' | 'assignedTo' | 'actor',
): Record<string, string | null> {
  const { userField, agentField } = getFieldNames(prefix);
  const isUser = isUserPrincipal(principal);
  return {
    [userField]: isUser ? principal.id : null,
    [agentField]: isUser ? null : principal.id,
  };
}
