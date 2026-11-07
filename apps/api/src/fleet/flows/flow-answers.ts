import { ValidationAppException } from '@nathapp/nestjs-common';
import { FLOW_ANSWER_MAX, FLOW_CALL_ID_MAX, FLOW_CALLS_MAX_FINDINGS } from './flow-calls';
import type { FlowAnswer } from './flow-calls';

export interface FlowAnswersInput {
  jobId: string;
  answers: FlowAnswer[];
}

function fail(reason: string): never {
  throw new ValidationAppException({ reason }, 'fleet.flows.answersInput');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse a complete human answer batch without normalizing ids or answer text. */
export function parseFlowAnswers(body: unknown): FlowAnswersInput {
  if (!isRecord(body)) fail('body');
  if (typeof body.jobId !== 'string' || body.jobId.trim().length === 0) fail('jobId');
  if (!Array.isArray(body.answers) || body.answers.length < 1 || body.answers.length > FLOW_CALLS_MAX_FINDINGS) fail('answers');

  const seen = new Set<string>();
  const answers: FlowAnswer[] = [];
  for (const [index, value] of body.answers.entries()) {
    const prefix = `answers[${index}]`;
    if (!isRecord(value)) fail(prefix);
    if (typeof value.id !== 'string' || value.id.trim().length === 0 || value.id.length > FLOW_CALL_ID_MAX) fail(`${prefix}.id`);
    if (typeof value.answer !== 'string' || value.answer.trim().length === 0 || value.answer.length > FLOW_ANSWER_MAX) fail(`${prefix}.answer`);
    if (seen.has(value.id)) fail(`${prefix}.id duplicate`);
    seen.add(value.id);
    answers.push({ id: value.id, answer: value.answer });
  }
  return { jobId: body.jobId, answers };
}
