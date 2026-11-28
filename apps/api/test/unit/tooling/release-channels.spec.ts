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
import { readWorkflow, stepBody } from './helpers/workflow-steps';

const workflow = readWorkflow('release.yml');

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
    writeFileSync(scriptFile, stepBody(workflow, 'id: channels'));
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
    name: 'AC-9: older stable patch only publishes version-only Docker tags',
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
    name: 'AC-2: newest canary retains both Docker aliases and npm canary',
    tag: 'v0.5.0-canary.10',
    remote: ['v0.5.0-canary.2', 'v0.5.0-canary.10'],
    expected: [
      'tags_api=nathapp/koda-api:canary',
      'tags_web=nathapp/koda-web:canary',
      'npm_tag=canary',
      'latest=false',
    ],
  },
  {
    name: 'AC-4: base version orders before canary sequence',
    tag: 'v0.5.1-canary.1',
    remote: ['v0.5.0-canary.99', 'v0.5.1-canary.1'],
    expected: [
      'tags_api=nathapp/koda-api:canary',
      'tags_web=nathapp/koda-web:canary',
      'npm_tag=canary',
      'latest=false',
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

function runDockerPublish(tags: string, app: 'api' | 'web'): { status: number; calls: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'koda-release-docker-'));
  try {
    const bin = join(dir, 'bin');
    const digestsDir = join(dir, 'digests');
    mkdirSync(bin);
    mkdirSync(digestsDir);
    writeFileSync(join(digestsDir, 'a'.repeat(64)), '');
    writeFileSync(join(digestsDir, 'b'.repeat(64)), '');
    const callsFile = join(dir, 'calls');
    const dockerFile = join(bin, 'docker');
    writeFileSync(
      dockerFile,
      `#!/bin/bash\nprintf '%s\\n' "$*" >> "$DOCKER_CALLS"\nif [[ "$1 $2 $3" == "buildx imagetools inspect" ]]; then\n  printf '%s\\n' '{"manifests":[{"platform":{"os":"linux","architecture":"amd64"}},{"platform":{"os":"linux","architecture":"arm64"}}]}'\nfi\n`,
    );
    chmodSync(dockerFile, 0o755);
    const jqFile = join(bin, 'jq');
    writeFileSync(jqFile, '#!/bin/bash\ncat >/dev/null\nexit 0\n');
    chmodSync(jqFile, 0o755);
    writeFileSync(join(dir, 'step.sh'), stepBody(workflow, 'id: merge'));
    const run = spawnSync('/bin/bash', ['-e', join(dir, 'step.sh')], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        DIGESTS_DIR: digestsDir,
        IMAGE: `docker.io/nathapp/koda-${app}`,
        TAGS: tags,
        DOCKER_CALLS: callsFile,
      },
      encoding: 'utf8',
    });
    return {
      status: run.status ?? 1,
      calls: readFileSync(callsFile, 'utf8').trim().split('\n'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runNpmCheck(): { status: number; output: string; calls: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'koda-release-npm-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const outputFile = join(dir, 'github-output');
    writeFileSync(outputFile, '');
    const callsFile = join(dir, 'calls');
    const npmFile = join(bin, 'npm');
    writeFileSync(
      npmFile,
      `#!/bin/bash\nprintf '%s\\n' "$*" >> "$NPM_CALLS"\nif [[ "$1" == "view" ]]; then exit 0; fi\nexit 9\n`,
    );
    chmodSync(npmFile, 0o755);
    writeFileSync(join(dir, 'step.sh'), stepBody(workflow, 'id: npm'));
    const run = spawnSync('/bin/bash', ['-e', join(dir, 'step.sh')], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        GITHUB_OUTPUT: outputFile,
        VERSION: '0.5.0-canary.10',
        NPM_CALLS: callsFile,
      },
      encoding: 'utf8',
    });
    return {
      status: run.status ?? 1,
      output: readFileSync(outputFile, 'utf8'),
      calls: readFileSync(callsFile, 'utf8').trim().split('\n'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('release workflow channels', () => {
  it.each(cases)('$name', ({ tag, remote, expected }) => {
    const result = runChannels(tag, remote);
    expect(result.status).toBe(0);
    expect(result.lines).toEqual([...expected].sort());
  });

  it('AC-4: lower base is stale despite its larger sequence', () => {
    const lower = runChannels('v0.5.0-canary.99', ['v0.5.0-canary.99', 'v0.5.1-canary.1']);
    expect(lower.status).not.toBe(0);
    expect(lower.lines).toEqual([]);
  });

  it('AC-2/AC-3: newest canary sends both Docker aliases and npm canary action', () => {
    const channels = runChannels('v0.5.0-canary.10', ['v0.5.0-canary.2', 'v0.5.0-canary.10']);
    const values = Object.fromEntries(channels.lines.map((line) => line.split('=')));
    expect(values.npm_tag).toBe('canary');
    for (const app of ['api', 'web'] as const) {
      const published = runDockerPublish(values[`tags_${app}`]!, app);
      expect(published.status).toBe(0);
      expect(published.calls[0]).toContain(`--tag nathapp/koda-${app}:canary`);
    }
  });

  it('AC-1: rejects stale canary before npm or Docker jobs, including published-version retries', () => {
    const result = runChannels('v0.5.0-canary.2', ['v0.5.0-canary.2', 'v0.5.0-canary.10']);
    expect(result.status).not.toBe(0);
    expect(result.lines).toEqual([]);
    expect(workflow).toMatch(/cli:\n    needs: info/);
    expect(workflow).toMatch(/docker-build:[\s\S]*?needs: \[info, cli\]/);
    expect(workflow).toContain('if: steps.npm.outputs.published != \'true\'');
  });

  it.each([
    ['major', 'v9.0.0-canary.1', 'v10.0.0-canary.1'],
    ['minor', 'v0.9.0-canary.1', 'v0.10.0-canary.1'],
    ['patch', 'v0.0.9-canary.1', 'v0.0.10-canary.1'],
    ['sequence', 'v0.0.0-canary.9', 'v0.0.0-canary.10'],
    ['major large', 'v9.0.0-canary.1', 'v9223372036854775808.0.0-canary.1'],
    ['major huge adjacent', 'v9223372036854775808.0.0-canary.1', 'v9223372036854775809.0.0-canary.1'],
    ['minor large', 'v0.9.0-canary.1', 'v0.9223372036854775808.0-canary.1'],
    ['patch large', 'v0.0.9-canary.1', 'v0.0.9223372036854775808-canary.1'],
    ['sequence large', 'v0.0.0-canary.9223372036854775808', 'v0.0.0-canary.9223372036854775809'],
  ])('AC-5: compares %s numerically', (_component, older, newer) => {
    const stale = runChannels(older, [older, newer]);
    expect(stale.status).not.toBe(0);
    const current = runChannels(newer, [older, newer]);
    expect(current.status).toBe(0);
    expect(current.lines).toContain('npm_tag=canary');
    expect(current.lines).toContain('tags_api=nathapp/koda-api:canary');
    expect(current.lines).toContain('tags_web=nathapp/koda-web:canary');
  });

  it('AC-9: stable backport Docker publish keeps only its version tag', () => {
    const channels = runChannels('v0.4.1', ['v0.4.0', 'v0.4.1', 'v0.4.2']);
    const tags = channels.lines.find((line) => line.startsWith('tags_api='))?.slice('tags_api='.length);
    expect(tags).toBe('nathapp/koda-api:v0.4.1');
    const publish = runDockerPublish(tags!, 'api');
    expect(publish.status).toBe(0);
    expect(publish.calls[0]).toContain('--tag nathapp/koda-api:v0.4.1');
    expect(publish.calls[0]).not.toContain(':0.4');
    expect(publish.calls[0]).not.toContain(':latest');
  });

  it('AC-8: an already published newest canary is retained as an npm skip', () => {
    const result = runNpmCheck();
    expect(result.status).toBe(0);
    expect(result.output.trim()).toBe('published=true');
    expect(result.calls).toEqual(['view @nathapp/koda-cli@0.5.0-canary.10 version']);
    const publishStep = workflow.slice(workflow.indexOf('- name: Publish to npm'));
    expect(publishStep).toContain("if: steps.npm.outputs.published != 'true'");
    expect(publishStep).toContain('run: npm publish --access public --tag "$NPM_TAG" --provenance');
  });

  it('AC-6: stable tags do not affect canary eligibility or outputs', () => {
    const canaryTags = ['v0.5.0-canary.2', 'v0.5.0-canary.10'];
    expect(runChannels(canaryTags[1]!, canaryTags).lines).toEqual(
      runChannels(canaryTags[1]!, [...canaryTags, 'v999.999.999']).lines,
    );
  });

  it('AC-7: a failed remote listing prevents canary publication', () => {
    const result = runChannels('v0.5.0-canary.10', [], 128);
    expect(result.status).not.toBe(0);
    expect(result.lines).toEqual([]);
  });

  it('also fails stable channel computation when the remote tag listing cannot be fetched', () => {
    const result = runChannels('v0.4.3', ['v0.4.2'], 128);
    expect(result.status).not.toBe(0);
  });

  it('keeps release channel output empty when listing remote tags fails', () => {
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

  it('B11: asks for the non-replacing release queue and documents recovery past it', () => {
    // A group keeps ONE pending run by default, so a third request would replace (cancel) the second before it
    // publishes. The group asks for the deeper, non-replacing queue — up to 100 pending runs, started in order —
    // and the recovery path for runs beyond that capacity is still documented (review B11).
    const concurrencyStart = workflow.indexOf('\nconcurrency:');
    expect(concurrencyStart).toBeGreaterThanOrEqual(0);
    const concurrencyBlock = workflow.slice(concurrencyStart + 1).split('\n\n')[0];
    expect(concurrencyBlock).toContain('queue: max');
    // Actions rejects `queue: max` with `cancel-in-progress: true`, and cancelling a running release is what the
    // shared publisher group prevents.
    expect(concurrencyBlock).toContain('cancel-in-progress: false');
    const comment = workflow.slice(0, concurrencyStart);
    expect(comment).toContain('workflow_dispatch');
    expect(comment).toContain('gh workflow run release.yml');
  });
});
