import { Command } from 'commander';
import { hostname } from 'node:os';
import { createCapabilityProbe } from './capabilities/create-probe';
import { startDaemon } from './daemon/daemon';
import { EnrollError, enrollRunner } from './commands/enroll';
import { runCommand } from './commands/run';
import { installService, uninstallService } from './commands/service';
import { collectStatus, formatStatus } from './commands/status';
import { resolveHome } from './config/runner-config';
import { dispatchInternal } from './internal-commands';
import { createConsoleLogger } from './logger';
import { ServiceError } from './service/units';
import { systemServiceDeps } from './service/system-deps';
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

const serviceAction = async (work: () => Promise<void>): Promise<void> => {
  try {
    await work();
  } catch (error) {
    if (!(error instanceof ServiceError)) throw error;
    process.exitCode = fail(error.message);
  }
};

program
  .command('install-service')
  .description('Install the daemon as a system service (systemd on Linux, launchd on macOS); run with sudo and --home')
  .requiredOption('--user <name>', 'the existing OS user the daemon runs as')
  .option('--binary <path>', 'the koda-runner binary the service runs (default: this one)')
  .option('--path <PATH>', 'PATH for the service; nax, git and gh must be on it (default: this PATH)')
  .option('--trust-workspace', 'when nax does not trust the workspace root yet, trust it (nax trust add, as --user)', false)
  .option('--apply-apparmor', 'Linux 24.04+: write and load a targeted AppArmor profile so bwrap may create user namespaces', false)
  .option('--print', 'print the unit and the commands; change nothing', false)
  .action((opts: { user: string; binary?: string; path?: string; trustWorkspace: boolean; applyApparmor: boolean; print: boolean }) =>
    serviceAction(() => installService({ ...opts, home: home() }, systemServiceDeps(say))));

program
  .command('uninstall-service')
  .description('Stop and remove the service install-service wrote; run with sudo')
  .action(() => serviceAction(() => uninstallService(systemServiceDeps(say))));

await program.parseAsync(process.argv);
