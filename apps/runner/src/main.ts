import { Command } from 'commander';
import { hostname } from 'node:os';
import { createCapabilityProbe } from './capabilities/create-probe';
import { startDaemon } from './daemon/daemon';
import { EnrollError, enrollRunner } from './commands/enroll';
import { runCommand } from './commands/run';
import { collectStatus, formatStatus } from './commands/status';
import { resolveHome } from './config/runner-config';
import { dispatchInternal } from './internal-commands';
import { createConsoleLogger } from './logger';
import { ServerClient } from './sync/http';
import { systemNow } from './time';
import { DAEMON_VERSION } from './version';

const internal = await dispatchInternal(process.argv.slice(2));
if (internal !== null) process.exit(internal);

const say = (line: string): void => { process.stdout.write(`${line}\n`); };
const fail = (message: string): number => { process.stderr.write(`koda-runner: ${message}\n`); return 1; };

const program = new Command()
  .name('koda-runner')
  .description('Koda fleet runner daemon: executes nax jobs dispatched by the koda API')
  .version(DAEMON_VERSION)
  .option('--home <dir>', 'runner home (default $KODA_RUNNER_HOME or ~/.koda-runner)');

const home = (): string | undefined => program.opts<{ home?: string }>().home;

program
  .command('enroll')
  .description('Register this machine with a koda server using a single-use enrollment token')
  .option('--token <token>', 'enrollment token (or set KODA_RUNNER_ENROLL_TOKEN)')
  .option('--server <url>', 'koda server origin, https unless loopback or --insecure-http')
  .option('--name <name>', 'runner name (default: the host name)')
  .option('--labels <labels>', 'comma-separated labels', (v: string) => v.split(',').map((l) => l.trim()).filter(Boolean), [] as string[])
  .option('--workspace <dir>', 'workspace root for clones and job files')
  .option('--insecure-http', 'allow plain http to a non-loopback server (VPN phase)', false)
  .action(async (opts: { token?: string; server?: string; name?: string; labels: string[]; workspace?: string; insecureHttp: boolean }) => {
    const token = opts.token ?? process.env['KODA_RUNNER_ENROLL_TOKEN'];
    if (!token) {
      process.exitCode = fail('an enrollment token is required: pass --token or set KODA_RUNNER_ENROLL_TOKEN');
      return;
    }
    try {
      await enrollRunner(
        { home: resolveHome(process.env, home()), server: opts.server, token, name: opts.name, labels: opts.labels, workspace: opts.workspace, insecureHttp: opts.insecureHttp },
        {
          env: process.env, hostname, platform: process.platform, arch: process.arch, probe: (config) => createCapabilityProbe(config, systemNow), now: systemNow,
          makeClient: (serverUrl) => new ServerClient({ serverUrl }), log: say,
        },
      );
    } catch (error) {
      if (!(error instanceof EnrollError)) throw error;
      process.exitCode = fail(error.message);
    }
  });

program
  .command('run')
  .description('Run the daemon in the foreground (a service manager supervises it in production)')
  .action(async () => {
    process.exitCode = await runCommand(home(), {
      env: process.env, log: createConsoleLogger(), start: startDaemon, onSignal: (signal, handler) => { process.on(signal, handler); },
    });
  });

program
  .command('status')
  .description('Show enrollment, queued work and whether the server answers')
  .option('--json', 'machine-readable output', false)
  .action(async (opts: { json: boolean }) => {
    const report = await collectStatus(home(), { env: process.env, makeClient: (serverUrl, apiKey) => new ServerClient({ serverUrl, apiKey }) });
    process.stdout.write(opts.json ? `${JSON.stringify(report)}\n` : formatStatus(report));
  });

await program.parseAsync(process.argv);
