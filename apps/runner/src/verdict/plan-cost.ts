import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { formatCost } from '../watcher/status-snapshot';

/** PLAN has no status.json. Its attempt-scoped ledgers hold per-call spend; report an absolute total. */
export async function readPlanCost(outDir: string): Promise<string | undefined> {
  const dir = join(outDir, 'cost');
  const files = await readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const seen = new Set<string>();
  let total = 0;
  for (const file of files.filter((f) => f.isFile() && f.name.endsWith('.jsonl')).sort((a, b) => a.name.localeCompare(b.name))) {
    const input = createReadStream(join(dir, file.name));
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        let row: unknown;
        try { row = JSON.parse(line); } catch { continue; }
        if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
        const { costUsd, callId } = row as Record<string, unknown>;
        if (typeof costUsd !== 'number' || !Number.isFinite(costUsd) || costUsd < 0) continue;
        if (typeof callId === 'string' && callId.length > 0) {
          if (seen.has(callId)) continue;
          seen.add(callId);
        }
        total += costUsd;
      }
    } finally {
      lines.close();
      input.destroy();
    }
  }
  return formatCost(total);
}
