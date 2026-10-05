export interface FinishView {
  readonly status?: string;
  readonly result?: string;
  readonly url?: string;
  readonly escalationReason?: string;
}

/** S2b (j): one nax post-run stage (acceptance, regression); only `status` is read. */
export interface StageView {
  readonly status?: string;
}

export interface StatusView {
  readonly run: { readonly id: string; readonly status: string; readonly pid?: number };
  readonly progress?: Readonly<Record<string, number>>;
  readonly cost?: { readonly spent?: number };
  readonly current?: { readonly storyId?: string; readonly phase?: string } | null;
  readonly lastHeartbeat?: string;
  readonly updatedAt?: string;
  readonly postRun?: { readonly acceptance?: StageView; readonly regression?: StageView; readonly finish?: FinishView };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const defined = <T extends Obj>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

/** A structural read of nax's `status.json` (src/execution/status-file.ts); unknown fields are dropped. */
export function parseStatusView(raw: unknown): StatusView | null {
  if (!isObj(raw) || !isObj(raw['run']) || typeof raw['run']['id'] !== 'string' || typeof raw['run']['status'] !== 'string') return null;
  const run = raw['run'];
  const progress = isObj(raw['progress'])
    ? (Object.fromEntries(Object.entries(raw['progress']).filter(([, v]) => typeof v === 'number')) as Record<string, number>)
    : undefined;
  const cost = isObj(raw['cost']) && typeof raw['cost']['spent'] === 'number' ? { spent: raw['cost']['spent'] } : undefined;
  const current = raw['current'] === null ? null : isObj(raw['current']) ? defined({ storyId: str(raw['current']['storyId']), phase: str(raw['current']['phase']) }) : undefined;
  const postRunRaw = isObj(raw['postRun']) ? raw['postRun'] : undefined;
  const stage = (key: 'acceptance' | 'regression'): StageView | undefined =>
    postRunRaw && isObj(postRunRaw[key]) ? defined({ status: str(postRunRaw[key]['status']) }) : undefined;
  const finishRaw = postRunRaw && isObj(postRunRaw['finish']) ? postRunRaw['finish'] : undefined;
  const finish = finishRaw ? defined({ status: str(finishRaw['status']), result: str(finishRaw['result']), url: str(finishRaw['url']), escalationReason: str(finishRaw['escalationReason']) }) : undefined;
  const postRunView = defined({ acceptance: stage('acceptance'), regression: stage('regression'), finish });
  return defined({
    run: defined({ id: run['id'] as string, status: run['status'] as string, pid: typeof run['pid'] === 'number' ? run['pid'] : undefined }),
    progress, cost, current, lastHeartbeat: str(raw['lastHeartbeat']), updatedAt: str(raw['updatedAt']), postRun: Object.keys(postRunView).length > 0 ? postRunView : undefined,
  }) as StatusView;
}

export const isFinalStatus = (status: StatusView): boolean => status.run.status !== 'running';
