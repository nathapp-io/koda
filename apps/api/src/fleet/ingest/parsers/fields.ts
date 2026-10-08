import { Prisma } from '../../../generated/prisma/client';

/** D365: typed readers for untrusted bundle JSON. Every reader returns null for anything it does not accept. */
export function str(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length === 0 ? null : t.slice(0, max);
}

export function nonNegInt(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  const n = Math.floor(v);
  return n <= 2_147_483_647 ? n : null;
}

export function money(v: unknown): string | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  // toFixed(), never toString(): Decimal prints values below 1e-7 as '3e-8'.
  return new Prisma.Decimal(v).toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP).toFixed();
}

export function date(v: unknown): Date | null {
  const d = typeof v === 'number' ? new Date(v) : typeof v === 'string' ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

export function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

export function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
