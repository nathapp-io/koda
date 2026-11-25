import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../../../../..');

describe.each([
  { file: 'docker-compose.dev.yml', service: 'postgres', port: '5432' },
  { file: 'docker-compose.test.yml', service: 'postgres-test', port: '5433' },
])('$file PostgreSQL port', ({ file, service, port }) => {
  it.each([
    { label: 'loopback by default', override: undefined, address: '127.0.0.1' },
    { label: 'an explicitly selected interface', override: '192.0.2.10', address: '192.0.2.10' },
  ])('binds to $label', ({ override, address }) => {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, DOCKER_CONFIG: process.env.DOCKER_CONFIG };
    if (override) env.KODA_POSTGRES_BIND_IP = override;
    const output = execFileSync('docker', ['compose', '-f', file, '--env-file', '/dev/null', 'config', '--format', 'json'], {
      cwd: root, env, encoding: 'utf8',
    });
    expect(JSON.parse(output).services[service].ports).toEqual([
      expect.objectContaining({ host_ip: address, published: port, target: 5432 }),
    ]);
  });
});
