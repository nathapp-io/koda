export const AGENT_RESULT_LIMITS = {
  budgetBytes: 12_288,
  maxOutputBytes: 8_192,
  maxDeniedAsks: 10,
  maxAskChars: 500,
  maxToolChars: 128,
  maxModelChars: 200,
} as const;

export interface AgentAssign {
  name: string;
  task: string;
  model?: string;
  modelAliases?: Record<string, string>;
  timeoutSec?: number;
}

export type AgentJobResult = {
  status: 'completed' | 'failed' | 'cancelled' | 'timeout';
  model?: string;
  output: string;
  truncated: boolean;
  deniedAsks: ({ kind: 'approval'; tool: string; summary: string } | { kind: 'question'; text: string })[];
  deniedAsksTruncated: boolean;
  costUsd?: string;
};
