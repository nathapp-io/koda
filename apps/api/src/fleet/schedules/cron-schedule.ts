import { CronExpressionParser } from 'cron-parser';

/** S1b §3.1: no two consecutive fires closer than this. */
export const MIN_FIRE_GAP_MS = 15 * 60 * 1000;
/** S1b §3.1: how many upcoming fires the gap check walks (plan D191: an approximation). */
export const GAP_CHECK_FIRES = 100;
/** Plan D191: the gap walk stops at the first fire further out than this (`0 0 29 2 *` is 4 years between fires). */
export const GAP_CHECK_HORIZON_MS = 2 * 365 * 24 * 60 * 60 * 1000;

export type CronFailure = 'syntax' | 'timezone' | 'too_frequent';

/** A cron or zone the schedule may not use. The caller maps `failure` to a 400 (plan D191). */
export class CronInputError extends Error {
  constructor(readonly failure: CronFailure, message: string) {
    super(message);
    this.name = 'CronInputError';
  }
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const NAMES = /(mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/gi;

/**
 * cron-parser pads missing fields and accepts six fields, aliases and Quartz tokens (`?`, `L`, `W`, `#`); a schedule
 * cron is exactly five standard fields (plan D191). Day and month names are standard and are kept.
 */
export function normalizeCron(expression: string): string {
  const fields = expression.trim().split(/\s+/).filter((field) => field !== '');
  if (fields.length !== 5) throw new CronInputError('syntax', 'a schedule cron has exactly five fields: minute hour day month weekday');
  const odd = fields.find((field) => /[^0-9*,/-]/.test(field.replace(NAMES, '')));
  if (odd !== undefined) throw new CronInputError('syntax', `unsupported token in ${JSON.stringify(odd)}: use digits, * , / - and day or month names`);
  return fields.join(' ');
}

/** The canonical IANA name of a zone the runtime and cron-parser both know; aliases are stored canonically (`EST` -> `America/Panama`). */
export function canonicalTimezone(timezone: string): string {
  let canonical: string;
  try {
    canonical = new Intl.DateTimeFormat('en-US', { timeZone: timezone }).resolvedOptions().timeZone;
  } catch {
    throw new CronInputError('timezone', `unknown timezone ${JSON.stringify(timezone)}`);
  }
  // Plan D191: Node accepts fixed offsets such as +08:00; they are not IANA zones and have no daylight saving.
  if (/^[+-]/.test(canonical)) throw new CronInputError('timezone', `${JSON.stringify(timezone)} is a fixed offset, not an IANA zone`);
  try {
    CronExpressionParser.parse('0 0 * * *', { currentDate: new Date(0), tz: canonical }).next();
  } catch {
    throw new CronInputError('timezone', `unsupported timezone ${JSON.stringify(timezone)}`);
  }
  return canonical;
}

/** The first fire strictly after `after`, with the cron read in `timezone`. */
export function nextFireAfter(cron: string, timezone: string, after: Date): Date {
  return CronExpressionParser.parse(cron, { currentDate: after, tz: timezone }).next().toDate();
}

/** The upcoming fires the gap check looks at: at most GAP_CHECK_FIRES, none further out than the horizon. */
export function walkFires(cron: string, timezone: string, now: Date): number[] {
  let iterator: ReturnType<typeof CronExpressionParser.parse>;
  try {
    iterator = CronExpressionParser.parse(cron, { currentDate: now, tz: timezone });
  } catch (error) {
    throw new CronInputError('syntax', messageOf(error));
  }
  const fires: number[] = [];
  for (let i = 0; i < GAP_CHECK_FIRES; i += 1) {
    let at: number;
    try {
      at = iterator.next().toDate().getTime();
    } catch (error) {
      throw new CronInputError('syntax', messageOf(error));
    }
    if (at - now.getTime() > GAP_CHECK_HORIZON_MS) break;
    fires.push(at);
  }
  return fires;
}

/** Validates a cron + zone for create and edit (S1b §3.1) and returns the values to store. */
export function assertCronAllowed(cron: string, timezone: string, now: Date): { cron: string; timezone: string } {
  const normalized = normalizeCron(cron);
  const zone = canonicalTimezone(timezone);
  const fires = walkFires(normalized, zone, now);
  for (let i = 1; i < fires.length; i += 1) {
    if (fires[i] - fires[i - 1] < MIN_FIRE_GAP_MS) {
      throw new CronInputError('too_frequent', `two fires are less than ${MIN_FIRE_GAP_MS / 60_000} minutes apart`);
    }
  }
  return { cron: normalized, timezone: zone };
}
