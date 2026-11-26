import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT, jobBlock, readWorkflow, stepBody } from './helpers/workflow-steps';

const release = readWorkflow('release.yml');

/**
 * The release builds each image once per platform on a native runner (arm64 under QEMU took 9-11 minutes), pushes
 * each by digest, then a merge job publishes the multi-arch tags. No layer cache is exported: GitHub Actions caches
 * are scoped to the ref that wrote them, so a tag's cache was never readable by the next tag.
 */
describe('release docker jobs', () => {
  const build = jobBlock(release, 'docker-build');
  const merge = jobBlock(release, 'docker');

  it('builds every app on every platform, each on its native runner', () => {
    expect(build).toContain('needs: [info, cli]');
    expect(build).toContain('app: [api, web]');
    expect(build).toContain('arch: [amd64, arm64]');
    expect(build).toMatch(/- arch: amd64\n\s+runner: ubuntu-latest\n/);
    expect(build).toMatch(/- arch: arm64\n\s+runner: ubuntu-24\.04-arm\n/);
    expect(build).toContain('runs-on: ${{ matrix.runner }}');
    expect(build).toContain('platforms: linux/${{ matrix.arch }}');
    expect(build).toContain('file: apps/${{ matrix.app }}/Dockerfile');
    expect(build).toContain('BUILD_APP_PACKAGE=@nathapp/koda-${{ matrix.app }}');
  });

  it('pushes each platform image by digest only; the tags are published by the merge job', () => {
    expect(build).toContain(
      'outputs: type=image,name=docker.io/nathapp/koda-${{ matrix.app }},push-by-digest=true,name-canonical=true,push=true',
    );
    expect(build).not.toMatch(/^\s+tags:/m);
    expect(build).toContain('name: digests-${{ matrix.app }}-${{ matrix.arch }}');
    expect(build).toContain('if-no-files-found: error');
    expect(build).toContain('retention-days: 7');
    expect(build).toContain('name: docker-build (${{ matrix.app }}, ${{ matrix.arch }})');
  });

  it('emulates nothing, exports no Actions cache and passes no turbo credentials', () => {
    expect(release).not.toContain('setup-qemu-action');
    expect(release).not.toContain('type=gha');
    expect(release).not.toContain('TURBO_TOKEN');
    expect(release).not.toContain('TURBO_TEAM');
  });

  it('merges per app after every platform build and gates the GitHub release on it', () => {
    expect(merge).toContain('needs: [info, docker-build]');
    expect(merge).toContain('app: [api, web]');
    expect(merge).toContain("TAGS: ${{ matrix.app == 'api' && needs.info.outputs.docker_tags_api || needs.info.outputs.docker_tags_web }}");
    expect(merge).toContain('pattern: digests-${{ matrix.app }}-*');
    expect(jobBlock(release, 'release')).toContain('needs: [info, cli, docker]');
  });

  it('the Dockerfiles no longer read a turbo token', () => {
    for (const app of ['api', 'web']) {
      const dockerfile = readFileSync(join(REPO_ROOT, 'apps', app, 'Dockerfile'), 'utf8');
      expect(dockerfile).not.toContain('TURBO_TOKEN');
      expect(dockerfile).not.toContain('TURBO_TEAM');
      expect(dockerfile).not.toContain('--mount=type=secret');
    }
  });
});

function withDir<T>(run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'koda-release-docker-'));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runBody(body: string, dir: string, env: Record<string, string>) {
  const script = join(dir, 'step.sh');
  writeFileSync(script, body);
  const result = spawnSync('/bin/bash', ['-e', script], {
    cwd: dir,
    env: { ...process.env, ...env, PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}` },
    encoding: 'utf8',
  });
  return { status: result.status ?? 1, output: `${result.stdout}${result.stderr}` };
}

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
// Pretty-printed with an attestation entry, as `docker buildx imagetools inspect --format '{{json .Manifest}}'` prints it.
const manifestJson = (...arches: string[]) =>
  JSON.stringify(
    {
      manifests: [
        ...arches.map((architecture) => ({ platform: { architecture, os: 'linux' } })),
        { platform: { architecture: 'unknown', os: 'unknown' } },
      ],
    },
    null,
    2,
  );
const BOTH_PLATFORMS = manifestJson('amd64', 'arm64');

describe('release docker steps', () => {
  it('records the pushed digest as a file named by its hash', () => {
    withDir((dir) => {
      const run = runBody(stepBody(release, 'id: digest'), dir, { DIGEST: `sha256:${DIGEST_A}`, RUNNER_TEMP: dir });
      expect(run.status).toBe(0);
      expect(existsSync(join(dir, 'digests', DIGEST_A))).toBe(true);
    });
  });

  it('refuses a missing or malformed digest', () => {
    for (const digest of ['', 'sha256:', 'sha256:abc123', DIGEST_A]) {
      withDir((dir) => {
        const run = runBody(stepBody(release, 'id: digest'), dir, { DIGEST: digest, RUNNER_TEMP: dir });
        expect(run.status).toBe(1);
        expect(run.output).toContain('not an image digest');
        expect(existsSync(join(dir, 'digests'))).toBe(false);
      });
    }
  });

  interface MergeCase {
    digests?: string[];
    tags?: string;
    inspect?: string;
  }

  function mergeRun({ digests = [DIGEST_A, DIGEST_B], tags = 'nathapp/koda-api:v0.5.1,nathapp/koda-api:0.5,nathapp/koda-api:latest', inspect = BOTH_PLATFORMS }: MergeCase = {}) {
    return withDir((dir) => {
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      const calls = join(dir, 'docker-calls');
      writeFileSync(
        join(bin, 'docker'),
        `#!/bin/bash\nprintf '%s\\n' "$*" >> "${calls}"\nif [[ "$3" == "inspect" ]]; then printf '%s\\n' "$INSPECT_JSON"; fi\n`,
      );
      chmodSync(join(bin, 'docker'), 0o755);
      const digestDir = join(dir, 'digests');
      mkdirSync(digestDir);
      for (const digest of digests) writeFileSync(join(digestDir, digest), '');
      const run = runBody(stepBody(release, 'id: merge'), dir, {
        DIGESTS_DIR: digestDir,
        IMAGE: 'docker.io/nathapp/koda-api',
        TAGS: tags,
        INSPECT_JSON: inspect,
      });
      const recorded = existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [];
      return { ...run, calls: recorded };
    });
  }

  it('publishes every tag over both platform digests, then checks both platforms are in it', () => {
    const run = mergeRun();
    expect(run.status).toBe(0);
    expect(run.calls).toEqual([
      'buildx imagetools create --tag nathapp/koda-api:v0.5.1 --tag nathapp/koda-api:0.5 --tag nathapp/koda-api:latest ' +
        `docker.io/nathapp/koda-api@sha256:${DIGEST_A} docker.io/nathapp/koda-api@sha256:${DIGEST_B}`,
      'buildx imagetools inspect nathapp/koda-api:v0.5.1 --format {{json .Manifest}}',
    ]);
  });

  it('fails when the published image is missing a platform', () => {
    const run = mergeRun({ inspect: manifestJson('amd64') });
    expect(run.status).toBe(1);
    expect(run.output).toContain('nathapp/koda-api:v0.5.1 has no linux/arm64 image');
  });

  it('refuses to publish unless both platform digests arrived, and says what to do on a late re-run', () => {
    for (const digests of [[], [DIGEST_A], [DIGEST_A, DIGEST_B, 'c'.repeat(64)]]) {
      const run = mergeRun({ digests });
      expect(run.status).toBe(1);
      expect(run.output).toContain(`expected 2 platform digests, found ${digests.length}`);
      expect(run.output).toContain('re-dispatch the release');
      expect(run.calls).toEqual([]);
    }
  });

  it("refuses tags that are not this image's, so one app's image is never published under the other's name", () => {
    for (const tags of ['', 'nathapp/koda-web:v0.5.1', 'nathapp/koda-api:v0.5.1,nathapp/koda-web:latest', 'nathapp/koda-api:', 'nathapp/koda-api-evil:v1']) {
      const run = mergeRun({ tags });
      expect(run.status).toBe(1);
      expect(run.output).toContain('is not a tag of nathapp/koda-api');
      expect(run.calls).toEqual([]);
    }
  });
});
