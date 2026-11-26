import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jobBlock, readWorkflow, stepBody } from './helpers/workflow-steps';

const release = readWorkflow('release.yml');

/**
 * Every OCI label the bun base image (oven/bun) sets. An image inherits its base image's labels, so each one must be
 * set again, or `docker image inspect` reports bun's revision, version and source as koda's.
 */
const BASE_IMAGE_LABELS = ['created', 'description', 'licenses', 'revision', 'source', 'title', 'url', 'version'];

/** The `labels: |` block of a job's build-push step, as key -> value. */
function imageLabels(job: string): Map<string, string> {
  const lines = jobBlock(release, job).split('\n');
  const start = lines.findIndex((line) => line === '          labels: |');
  if (start < 0) throw new Error(`${job} sets no labels`);
  const labels = new Map<string, string>();
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('            ')) break;
    const [key, ...value] = line.trim().split('=');
    labels.set(key ?? '', value.join('='));
  }
  return labels;
}

describe('release image labels', () => {
  // One build job per app and platform (release-docker-jobs.spec.ts); the labels are templated per app.
  const job = 'docker-build';

  it(`${job} overrides every OCI label the base image sets`, () => {
    const labels = imageLabels(job);
    expect([...labels.keys()].sort()).toEqual(BASE_IMAGE_LABELS.map((name) => `org.opencontainers.image.${name}`));
  });

  it(`${job} labels the image with koda's own commit, version and source`, () => {
    const labels = imageLabels(job);
    expect(labels.get('org.opencontainers.image.title')).toBe('koda-${{ matrix.app }}');
    expect(labels.get('org.opencontainers.image.description')).toBe('${{ matrix.description }}');
    expect(labels.get('org.opencontainers.image.version')).toBe('${{ needs.info.outputs.version }}');
    expect(labels.get('org.opencontainers.image.revision')).toBe('${{ needs.info.outputs.revision }}');
    expect(labels.get('org.opencontainers.image.created')).toBe('${{ needs.info.outputs.created }}');
    expect(labels.get('org.opencontainers.image.source')).toBe('https://github.com/${{ github.repository }}');
    expect(labels.get('org.opencontainers.image.url')).toBe('https://github.com/${{ github.repository }}');
    expect(labels.get('org.opencontainers.image.licenses')).toBe('MIT');
  });

  it('every app has a description for its label', () => {
    const block = jobBlock(release, job);
    expect(block).toMatch(/- app: api\n\s+description: \S/);
    expect(block).toMatch(/- app: web\n\s+description: \S/);
  });

  it('info exports the release commit as revision and created', () => {
    const info = jobBlock(release, 'info');
    expect(info).toContain('revision: ${{ steps.commit.outputs.revision }}');
    expect(info).toContain('created: ${{ steps.commit.outputs.created }}');
  });

  it('the release commit step reports the checked-out commit and its commit time', () => {
    const dir = mkdtempSync(join(tmpdir(), 'koda-release-commit-'));
    try {
      const env = {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'test',
        GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'test',
        GIT_COMMITTER_EMAIL: 'test@example.invalid',
        GIT_AUTHOR_DATE: '2026-11-20T01:02:03Z',
        GIT_COMMITTER_DATE: '2026-11-20T01:02:03Z',
        TZ: 'UTC',
      };
      const git = (...args: string[]) => spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' }).stdout.trim();
      git('init', '-q');
      git('commit', '-q', '--allow-empty', '-m', 'release');
      const sha = git('rev-parse', 'HEAD');

      const outputFile = join(dir, 'github-output');
      writeFileSync(outputFile, '');
      const scriptFile = join(dir, 'step.sh');
      writeFileSync(scriptFile, stepBody(release, 'id: commit'));
      const result = spawnSync('/bin/bash', ['-e', scriptFile], {
        cwd: dir,
        env: { ...env, GITHUB_OUTPUT: outputFile },
        encoding: 'utf8',
      });

      expect(result.status).toBe(0);
      const outputs = readFileSync(outputFile, 'utf8').trim().split('\n').sort();
      expect(outputs).toEqual(['created=2026-11-20T01:02:03Z', `revision=${sha}`]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
