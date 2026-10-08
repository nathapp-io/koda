import { Command } from 'commander';
import {
  meNotificationsControllerList,
  meNotificationsControllerMarkAllRead,
  meNotificationsControllerMarkRead,
} from '../generated';
import { table } from '../utils/output';
import { unwrap } from '../utils/api';
import { handleApiError } from '../utils/error';
import { withContext } from '../utils/context';
import { parsePositiveInt } from '../utils/parse-positive-int';

interface NotificationRow {
  id: string;
  kind: string;
  title: string;
  link: string;
  readAt: string | null;
  createdAt: string;
}

interface NotificationPage {
  total: number;
  current: number;
  hasNext: boolean;
  records: NotificationRow[];
}

// Inboxes belong to users: pass a user access token through KODA_API_KEY (agent keys get 403).
const TOKEN_HINT = 'Requires a user access token: KODA_API_KEY=<token> koda notifications …';

export function notificationsCommand(program: Command): void {
  const notifications = program.command('notifications');
  notifications.description(`My in-app notifications. ${TOKEN_HINT}`);

  notifications
    .command('list', { isDefault: true })
    .description('List my notifications, newest first')
    .option('--unread', 'Only unread notifications')
    .option('--page <n>', 'Page number', parsePositiveInt, 1)
    .option('--size <n>', 'Page size (1-100)', parsePositiveInt, 20)
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        await withContext({}, { requireProject: false });
        const response = await meNotificationsControllerList({
          query: { current: options.page, size: options.size, ...(options.unread ? { unread: 'true' as const } : {}) },
        });
        const page = unwrap<NotificationPage>(response);
        if (options.json) {
          console.log(JSON.stringify(page, null, 2));
        } else {
          table(['ID', 'Unread', 'When', 'Title', 'Link'], page.records.map((n) => [
            n.id, n.readAt ? '' : '*', n.createdAt.slice(0, 16).replace('T', ' '), n.title, n.link,
          ]));
          if (page.hasNext) console.log(`Next: --page ${page.current + 1}`);
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });

  notifications
    .command('read [id]')
    .description('Mark one notification read, or every one with --all')
    .option('--all', 'Mark all my notifications read')
    .action(async (id: string | undefined, options) => {
      if (!id && !options.all) {
        console.error('Give a notification id or --all');
        process.exit(1);
        return;
      }
      try {
        await withContext({}, { requireProject: false });
        if (options.all) {
          await meNotificationsControllerMarkAllRead({});
          console.log('All notifications marked read');
        } else {
          await meNotificationsControllerMarkRead({ path: { id: id as string } });
          console.log(`Marked ${id} read`);
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `No such notification: ${id}` });
      }
    });
}
