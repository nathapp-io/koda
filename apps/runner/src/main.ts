import { Command } from 'commander';
import { DAEMON_VERSION } from './version';

const program = new Command().name('koda-runner').description('Koda fleet runner daemon').version(DAEMON_VERSION);
await program.parseAsync(process.argv);
