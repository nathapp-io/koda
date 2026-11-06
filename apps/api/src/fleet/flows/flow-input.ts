import { posix } from 'node:path';
import { ValidationAppException } from '@nathapp/nestjs-common';
import { parseGitHubUrl } from '../../skills/github-url';
import { FEATURE_RE, GIT_REF_RE } from '../jobs/dispatch-input';

export type FlowEntry = 'THREAD' | 'NAX';
export interface NormalizedFlowFeature { feature: string; specPath: string; dependsOn: string[] }
export interface NormalizedFlowInput {
  features: NormalizedFlowFeature[];
  roles: { reviewer: string; supervisor: string };
  costCapUsd: string;
  remoteUrl?: string;
  branch?: string;
  specSha?: string;
}

export interface NormalizedNaxFlowInput extends NormalizedFlowInput {
  remoteUrl: string;
  branch: string;
  specSha: string;
}

const ROLE_RE = /^[A-Za-z0-9._:/\x5b\x5d=,-]{1,200}$/;
const SPEC_SHA_RE = /^[a-f0-9]{40}$/;
const COST_RE = /^\d+(?:\.\d{1,4})?$/;

function fail(property: string): never {
  throw new ValidationAppException({ reason: property }, 'fleet.flowInput');
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse the untrusted create body into the stable JSON shape used by flow commands. */
export function parseFlowInput(body: unknown, entry: 'NAX'): NormalizedNaxFlowInput;
export function parseFlowInput(body: unknown, entry: FlowEntry): NormalizedFlowInput;
export function parseFlowInput(body: unknown, entry: FlowEntry): NormalizedFlowInput {
  if (entry !== 'THREAD' && entry !== 'NAX') fail('features');
  if (!isRecord(body)) fail('features');
  if (!Array.isArray(body.features) || body.features.length < 1 || body.features.length > 20) fail('features');

  const featureNames = new Set<string>();
  const features: NormalizedFlowFeature[] = body.features.map((item, index) => {
    if (!isRecord(item) || typeof item.feature !== 'string' || !FEATURE_RE.test(item.feature) || featureNames.has(item.feature)) fail(`features.${index}.feature`);
    const name = item.feature;
    featureNames.add(name);
    if (typeof item.specPath !== 'string' || item.specPath.length < 1 || item.specPath.length > 300 || item.specPath.includes('\0') || item.specPath.startsWith('/') || !item.specPath.endsWith('.md') || item.specPath.split('/').includes('..')) fail(`features.${index}.specPath`);
    const dependsOn = item.dependsOn === undefined ? [] : item.dependsOn;
    if (!Array.isArray(dependsOn) || dependsOn.some((dependency) => typeof dependency !== 'string' || !featureNames.has(dependency) || dependency === name) || new Set(dependsOn).size !== dependsOn.length) fail(`features.${index}.dependsOn`);
    return { feature: name, specPath: posix.normalize(item.specPath), dependsOn: [...dependsOn] as string[] };
  });

  if (!isRecord(body.roles) || typeof body.roles.reviewer !== 'string' || !ROLE_RE.test(body.roles.reviewer)) fail('roles.reviewer');
  if (!isRecord(body.roles) || typeof body.roles.supervisor !== 'string' || !ROLE_RE.test(body.roles.supervisor)) fail('roles.supervisor');
  const costCap = body.costCapUsd;
  if ((typeof costCap !== 'number' && typeof costCap !== 'string') || !Number.isFinite(Number(costCap)) || Number(costCap) <= 0 || Number(costCap) > 1000 || !COST_RE.test(String(costCap))) fail('costCapUsd');

  const normalized: NormalizedFlowInput = {
    features,
    roles: { reviewer: body.roles.reviewer, supervisor: body.roles.supervisor },
    costCapUsd: String(costCap),
  };
  if (entry === 'NAX') {
    if (typeof body.remoteUrl !== 'string') fail('remoteUrl');
    try { parseGitHubUrl(body.remoteUrl); } catch { fail('remoteUrl'); }
    if (typeof body.branch !== 'string' || !GIT_REF_RE.test(body.branch)) fail('branch');
    if (typeof body.specSha !== 'string' || !SPEC_SHA_RE.test(body.specSha)) fail('specSha');
    normalized.remoteUrl = body.remoteUrl;
    normalized.branch = body.branch;
    normalized.specSha = body.specSha;
  }
  return normalized;
}
