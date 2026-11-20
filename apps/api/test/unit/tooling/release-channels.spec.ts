import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workflow = readFileSync(
  join(__dirname, '../../../../..', '.github/workflows/release.yml'),
  'utf8',
);

function stepBody(identity: string): string {
  const lines = workflow.split('\n');
  let stepStart = -1;
  let stepEnd = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith('      - ')) continue;
    let end = index + 1;
    while (end < lines.length && !/^      - /.test(lines[end]) && !/^    [^ ]/.test(lines[end])) end += 1;
    if (lines.slice(index, end).some((line) => line.trim() === identity)) {
      stepStart = index;
      stepEnd = end;
      break;
    }
  }
  if (stepStart < 0) throw new Error(`Workflow step ${identity} not found`);
  const runIndex = lines.findIndex((line, index) => index > stepStart && index < stepEnd && /^        run: \|$/.test(line));
  if (runIndex < 0) throw new Error(`Run body not found for ${identity}`);
  const bodyLines: string[] = [];
  for (let index = runIndex + 1; index < stepEnd; index += 1) {
    const line = lines[index];
    if (line.trim() && !line.startsWith('          ')) break;
    bodyLines.push(line.startsWith('          ') ? line.slice(10) : '');
  }
  return bodyLines.join('\n').replace(/^\n+|\n+$/g, '');
}

interface ChannelRun {
  status: number;
  lines: string[];
}

function runChannels(tag: string, remoteTags: string[], gitExit = 0): ChannelRun {
  const dir = mkdtempSync(join(tmpdir(), 'koda-release-channels-'));
  try {
    const bin = join(dir, 'bin');
    const outputFile = join(dir, 'github-output');
    writeFileSync(outputFile, '');
    const scriptFile = join(dir, 'step.sh');
    const gitFile = join(bin, 'git');
    mkdirSync(bin);
    writeFileSync(scriptFile, stepBody('id: channels'));
    writeFileSync(
      gitFile,
      `#!/bin/bash\nif [[ "$1" == "ls-remote" ]]; then\n  printf '%s\\n' "$REMOTE_TAGS"\n  exit "$GIT_EXIT"\nfi\nexit 2\n`,
    );
    chmodSync(gitFile, 0o755);
    const remoteLines = remoteTags.map((value) => `abc\trefs/tags/${value}`).join('\n');
    const result = spawnSync('/bin/bash', ['-e', scriptFile], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        GITHUB_OUTPUT: outputFile,
        TAG: tag,
        VERSION: tag.slice(1),
        REMOTE_TAGS: remoteLines,
        GIT_EXIT: String(gitExit),
      },
      encoding: 'utf8',
    });
    const lines = readFileSync(outputFile, 'utf8').trim().split('\n').filter(Boolean).sort();
    return { status: result.status ?? 1, lines };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const cases = [
  {
    name: 'AC-1: stable newest publishes floating aliases',
    tag: 'v0.4.3',
    remote: ['v0.4.0', 'v0.4.1', 'v0.4.2'],
    expected: [
      'tags_api=nathapp/koda-api:v0.4.3,nathapp/koda-api:0.4,nathapp/koda-api:latest',
      'tags_web=nathapp/koda-web:v0.4.3,nathapp/koda-web:0.4,nathapp/koda-web:latest',
      'npm_tag=latest',
      'latest=true',
    ],
  },
  {
    name: 'AC-2: re-publishing the newest stable version preserves floating aliases',
    tag: 'v0.4.2',
    remote: ['v0.4.0', 'v0.4.1', 'v0.4.2'],
    expected: [
      'tags_api=nathapp/koda-api:v0.4.2,nathapp/koda-api:0.4,nathapp/koda-api:latest',
      'tags_web=nathapp/koda-web:v0.4.2,nathapp/koda-web:0.4,nathapp/koda-web:latest',
      'npm_tag=latest',
      'latest=true',
    ],
  },
  {
    name: 'AC-3: older stable patch only publishes an immutable backport npm tag',
    tag: 'v0.4.1',
    remote: ['v0.4.0', 'v0.4.1', 'v0.4.2'],
    expected: [
      'tags_api=nathapp/koda-api:v0.4.1',
      'tags_web=nathapp/koda-web:v0.4.1',
      'npm_tag=backport-0.4.1',
      'latest=false',
    ],
  },
  {
    name: 'AC-4: newest patch on older minor advances that minor alias only',
    tag: 'v0.3.5',
    remote: ['v0.3.4', 'v0.4.2'],
    expected: [
      'tags_api=nathapp/koda-api:v0.3.5,nathapp/koda-api:0.3',
      'tags_web=nathapp/koda-web:v0.3.5,nathapp/koda-web:0.3',
      'npm_tag=release-0.3',
      'latest=false',
    ],
  },
  {
    name: 'AC-5: stable versions compare numerically by component',
    tag: 'v0.10.0',
    remote: ['v0.9.9'],
    expected: [
      'tags_api=nathapp/koda-api:v0.10.0,nathapp/koda-api:0.10,nathapp/koda-api:latest',
      'tags_web=nathapp/koda-web:v0.10.0,nathapp/koda-web:0.10,nathapp/koda-web:latest',
      'npm_tag=latest',
      'latest=true',
    ],
  },
  {
    name: 'AC-6: canary remote tags do not affect stable channel selection',
    tag: 'v0.4.3',
    remote: ['v0.4.2', 'v0.5.0-canary.2'],
    expected: [
      'tags_api=nathapp/koda-api:v0.4.3,nathapp/koda-api:0.4,nathapp/koda-api:latest',
      'tags_web=nathapp/koda-web:v0.4.3,nathapp/koda-web:0.4,nathapp/koda-web:latest',
      'npm_tag=latest',
      'latest=true',
    ],
  },
  {
    name: 'AC-7: canary retains only the dedicated canary channels',
    tag: 'v0.5.0-canary.1',
    remote: ['v0.4.2'],
    expected: [
      'tags_api=nathapp/koda-api:canary',
      'tags_web=nathapp/koda-web:canary',
      'npm_tag=canary',
      'latest=false',
    ],
  },
  {
    name: 'B8: a zero-padded remote version stays in the minor it belongs to',
    tag: 'v0.4.1',
    remote: ['v0.04.2'],
    expected: [
      'tags_api=nathapp/koda-api:v0.4.1',
      'tags_web=nathapp/koda-web:v0.4.1',
      'npm_tag=backport-0.4.1',
      'latest=false',
    ],
  },
  {
    name: 'B8: a remote component beyond the 64-bit range is still newer, not wrapped',
    tag: 'v0.4.1',
    remote: ['v9223372036854775808.0.0'],
    expected: [
      'tags_api=nathapp/koda-api:v0.4.1,nathapp/koda-api:0.4',
      'tags_web=nathapp/koda-web:v0.4.1,nathapp/koda-web:0.4',
      'npm_tag=release-0.4',
      'latest=false',
    ],
  },
];

describe('release workflow channels', () => {
  it.each(cases)('$name', ({ tag, remote, expected }) => {
    const result = runChannels(tag, remote);
    expect(result.status).toBe(0);
    expect(result.lines).toEqual([...expected].sort());
  });

  it('AC-8: fails when the remote stable tag listing cannot be fetched', () => {
    const result = runChannels('v0.4.3', ['v0.4.2'], 128);
    expect(result.status).not.toBe(0);
  });

  it('AC-11: writes no release channel assignments when listing remote tags fails', () => {
    const result = runChannels('v0.4.3', ['v0.4.2'], 128);
    expect(result.lines).toEqual([]);
  });

  it('AC-9: maps all release info outputs to the channels step as one mapping', () => {
    const infoStart = workflow.indexOf('  info:');
    const infoEnd = workflow.indexOf('\n  # ─── CLI:', infoStart);
    const infoJob = workflow.slice(infoStart, infoEnd);
    const outputsStart = infoJob.indexOf('    outputs:');
    const outputsEnd = infoJob.indexOf('\n    steps:', outputsStart);
    const outputs = infoJob.slice(outputsStart, outputsEnd);
    const mapping = {
      npm_tag: outputs.match(/^      npm_tag: (.+)$/m)?.[1],
      docker_tags_api: outputs.match(/^      docker_tags_api: (.+)$/m)?.[1],
      docker_tags_web: outputs.match(/^      docker_tags_web: (.+)$/m)?.[1],
      latest: outputs.match(/^      latest: (.+)$/m)?.[1],
    };
    expect(mapping).toEqual({
      npm_tag: '${{ steps.channels.outputs.npm_tag }}',
      docker_tags_api: '${{ steps.channels.outputs.tags_api }}',
      docker_tags_web: '${{ steps.channels.outputs.tags_web }}',
      latest: '${{ steps.channels.outputs.latest }}',
    });
  });

  it('AC-10: configures GitHub Release latest from the info job output', () => {
    const releaseStart = workflow.indexOf('\n  release:');
    const notifyStart = workflow.indexOf('\n  # ─── Notify', releaseStart);
    const releaseJob = workflow.slice(releaseStart, notifyStart);
    const ghStepStart = releaseJob.indexOf('uses: softprops/action-gh-release');
    const withStart = releaseJob.indexOf('        with:', ghStepStart);
    const nextStep = releaseJob.indexOf('\n      - ', withStart);
    const withBlock = releaseJob.slice(withStart, nextStep < 0 ? undefined : nextStep);
    expect(withBlock).toContain('make_latest: ${{ needs.info.outputs.latest }}');
  });

  it('B4: serializes every release run in one publisher group', () => {
    // A run computes its channels in `info` and publishes much later (approval, builds). Only a single
    // repository-wide group, queued rather than cancelled, keeps a second run from publishing in between, so
    // the eligibility is computed inside the serialized stage (review B4).
    const concurrencyStart = workflow.indexOf('\nconcurrency:');
    expect(concurrencyStart).toBeGreaterThanOrEqual(0);
    const concurrencyBlock = workflow.slice(concurrencyStart + 1).split('\n\n')[0];
    expect(concurrencyBlock).toContain('group: release-publish');
    expect(concurrencyBlock).toContain('cancel-in-progress: false');
    // A ref-scoped group would not serialize a tag push against a manual re-publish of another tag.
    expect(concurrencyBlock).not.toContain('${{');
    expect(workflow.slice(0, concurrencyStart)).not.toContain('concurrency:');
  });

  it('B11: documents the one-pending-slot queue and how a cancelled release is recovered', () => {
    // GitHub keeps one running run and ONE pending run per group, so a third request is cancelled before it
    // publishes. That run cannot be replaced from the workflow (it never starts), so the comment must say so
    // and name the recovery path (review B11).
    const concurrencyStart = workflow.indexOf('\nconcurrency:');
    const comment = workflow.slice(0, concurrencyStart);
    expect(comment).toContain('ONE pending run');
    expect(comment).toContain('workflow_dispatch');
    expect(comment).toContain('gh workflow run release.yml');
  });
});
