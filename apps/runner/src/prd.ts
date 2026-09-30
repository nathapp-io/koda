export interface PrdInfo {
  readonly stories: number;
  readonly branchName: string | null;
}

export function parsePrd(text: string): PrdInfo | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const branch = typeof record['branchName'] === 'string' ? record['branchName'].trim() : '';
  return { stories: Array.isArray(record['userStories']) ? record['userStories'].length : 0, branchName: branch === '' ? null : branch };
}
