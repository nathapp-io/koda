/** Structural mirrors of the agent job fields in @nathapp/fleet-protocol. */
export const AGENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface AgentJobInput {
  name: string;
  task: string;
  model?: string;
  modelAliases?: Record<string, string>;
  timeoutSec?: number;
}

export type AgentDeniedAsk =
  | { kind: 'approval'; tool: string; summary: string }
  | { kind: 'question'; text: string };

export interface AgentJobResult {
  status: 'completed' | 'failed' | 'cancelled' | 'timeout';
  model?: string;
  output: string;
  truncated: boolean;
  deniedAsks: AgentDeniedAsk[];
  deniedAsksTruncated: boolean;
  costUsd?: string;
}
