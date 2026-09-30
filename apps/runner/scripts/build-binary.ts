/** `bun run build:binary` builds for this host; `bun run build:binary all` builds the three release targets. */
const TARGETS = ['bun-darwin-arm64', 'bun-darwin-x64', 'bun-linux-x64'] as const;
const arg = process.argv[2];
const targets = arg === 'all' ? TARGETS : [undefined];

for (const target of targets) {
  const suffix = target ? `-${target.replace('bun-', '')}` : '';
  const proc = Bun.spawn(['bun', 'build', './src/main.ts', '--compile', ...(target ? [`--target=${target}`] : []), `--outfile=dist/koda-runner${suffix}`], {
    cwd: `${import.meta.dir}/..`, stdout: 'inherit', stderr: 'inherit',
  });
  if ((await proc.exited) !== 0) process.exit(1);
}
