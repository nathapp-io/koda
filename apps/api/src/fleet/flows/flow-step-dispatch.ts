import { Prisma } from '../../generated/prisma/client';
import type { DispatchFleetJobDto } from '../jobs/dto/dispatch-fleet-job.dto';
import type { FlowStep } from './flow-steps';
import { buildReviewTask } from './flow-steps';
import { buildRuleTask, type FlowOpenItem, type FlowRuleGuidance } from './flow-rulings';

const MIN_REMAINING_CAP_USD = new Prisma.Decimal('0.0001');

/** Return the usable flow budget, rounded down to the dispatch DTO's four-decimal precision. */
export function remainingCapUsd(capUsd: string, spentUsd: string): string | null {
  const remaining = new Prisma.Decimal(capUsd).minus(spentUsd).toDecimalPlaces(4, Prisma.Decimal.ROUND_DOWN);
  return remaining.lt(MIN_REMAINING_CAP_USD) ? null : remaining.toFixed(4);
}

export interface BuildStepDispatchInput {
  flow: {
    repoId: string;
    branch: string;
    specSha: string;
    reviewerRole: string;
    pinnedRunnerId: string | null;
  };
  /** The feature the step runs for; its own branch wins over the flow branch once it has one. */
  feature: { feature: string; specPath: string; branch?: string | null };
  /** Every spec path of the flow's set, in position order: a set review covers them all at once. */
  setSpecPaths?: string[];
  step: FlowStep;
  prdEdits?: boolean;
  remainingCapUsd: string;
  reviewAgent: string;
  plan?: { resultSha: string | null; resultBranch: string | null };
  pr?: { number: number };
  rule?: { ref: string; prNumber: number; items: FlowOpenItem[]; guidance: FlowRuleGuidance | null };
}

export function buildStepDispatch(input: BuildStepDispatchInput): DispatchFleetJobDto {
  const { flow, feature, step } = input;
  const common = {
    repoId: flow.repoId,
    maxCostUsd: new Prisma.Decimal(input.remainingCapUsd).toNumber(),
    ...(flow.pinnedRunnerId !== null ? { pinnedRunnerId: flow.pinnedRunnerId } : {}),
  };

  switch (step) {
    case 'SPEC_REVIEW':
    case 'PRD_REVIEW': {
      const ref = step === 'SPEC_REVIEW' ? flow.specSha : requirePlan(input, step).resultSha;
      if (!ref) throw new Error(`${step} requires a PLAN result sha`);
      return {
        ...common,
        command: 'AGENT',
        feature: feature.feature,
        ref,
        bashMode: 'raw',
        agent: {
          name: input.reviewAgent,
          task: buildReviewTask(step, feature.specPath, feature.feature, {
            prdEdits: input.prdEdits === true,
            // The set review covers every spec of the flow at once.
            ...(step === 'SPEC_REVIEW' && input.setSpecPaths !== undefined ? { setSpecPaths: input.setSpecPaths } : {}),
          }),
          model: flow.reviewerRole,
        },
      };
    }
    case 'PLAN':
      // A feature that has its own branch plans against it; the flow branch is the fallback.
      return {
        ...common, command: 'PLAN', ref: feature.branch ?? flow.branch, feature: feature.feature,
        planFrom: feature.specPath, profiles: [],
      };
    case 'RUN': {
      const ref = requirePlan(input, step).resultBranch;
      if (!ref) throw new Error('RUN requires a PLAN result branch');
      return {
        ...common, command: 'RUN', ref,
        feature: feature.feature, profiles: [],
      };
    }
    case 'RULE': {
      const rule = input.rule;
      if (!rule) throw new Error('RULE requires the RUN branch and PR');
      return {
        ...common,
        command: 'AGENT',
        feature: feature.feature,
        ref: rule.ref,
        bashMode: 'raw',
        agent: {
          name: input.reviewAgent,
          task: buildRuleTask({ prNumber: rule.prNumber, items: rule.items, guidance: rule.guidance }),
          model: flow.reviewerRole,
        },
      };
    }
    case 'REVIEW':
    case 'FIX':
      if (!input.pr) throw new Error(`${step} requires a PR number`);
      return {
        ...common, command: step, prNumber: input.pr.number, profiles: [],
      };
  }
}

function requirePlan(input: BuildStepDispatchInput, step: FlowStep): NonNullable<BuildStepDispatchInput['plan']> {
  if (!input.plan) throw new Error(`${step} requires the missing PLAN job`);
  return input.plan;
}
