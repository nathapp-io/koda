import { Inject, Injectable } from '@nestjs/common';
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { Readable } from 'stream';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { FLEET_JOB_REPOSITORY, FleetJobRecord, IFleetJobRepository } from '../jobs/domain/fleet-job.domain';
import {
  FLEET_JOB_LOG_REPOSITORY, FleetJobLogRecord, IFleetJobLogRepository, isLogStream, LOG_STREAMS, LogSource, LogStreamName,
} from './domain/fleet-job-log.domain';
import { LogEntryView, LogFilter, toEntry } from './log-entry';
import { backwardReadRange, backwardSpans, forwardReadRange, forwardSpans, ScanOptions, SpanWindow, visibleEnd } from './log-lines';
import { FleetLogExpiredException } from './log-read.exceptions';
import { LOG_STORE, LogStore, logKey } from './log-store';

/** Spec §3.2: max bytes of one raw range request. */
export const RAW_MAX_BYTES = 1024 * 1024;
/** D334: yield to the event loop after this many processed bytes. */
const YIELD_BYTES = 256 * 1024;
const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export interface EntriesParams extends LogFilter {
  leaseEpoch?: number;
  cursor?: number;
  direction: 'forward' | 'backward';
  limit: number;
}

export interface EntriesPage {
  entries: LogEntryView[];
  nextCursor: number;
  scannedFrom: number;
  scannedTo: number;
  atEnd: boolean;
  size: number;
  complete: boolean;
  truncated: boolean;
}

export interface LogStreamSummary {
  stream: LogStreamName;
  sizeBytes: number;
  complete: boolean;
  truncated: boolean;
  source: LogSource;
  expired: boolean;
  updatedAt: string;
}

export interface LogAttemptSummary {
  leaseEpoch: number;
  legacySampled: boolean;
  streams: LogStreamSummary[];
}

export interface LogDownload {
  jobId: string;
  leaseEpoch: number;
  stream: LogStreamName;
  sizeBytes: number;
  body: Readable;
}

interface Target {
  job: FleetJobRecord;
  stream: LogStreamName;
  leaseEpoch: number;
  key: string;
  row: FleetJobLogRecord | null;
}

interface ScannedWindow extends SpanWindow {
  buf: Buffer;
  bufStart: number;
}

const summary = (r: FleetJobLogRecord): LogStreamSummary => ({
  stream: r.stream, sizeBytes: r.sizeBytes, complete: r.complete, truncated: r.truncated, source: r.source,
  expired: Boolean(r.expiredAt), updatedAt: r.updatedAt.toISOString(),
});

/** Fleet S2a §3: the user read side over LogStore + FleetJobLog. Lock-free (D333). */
@Injectable()
export class LogReadService {
  constructor(
    @Inject(FLEET_JOB_REPOSITORY) private readonly jobs: Pick<IFleetJobRepository, 'findById'>,
    @Inject(FLEET_JOB_LOG_REPOSITORY) private readonly logs: Pick<IFleetJobLogRepository, 'findStream' | 'listForJob' | 'findLogEventEpochs'>,
    @Inject(LOG_STORE) private readonly store: Pick<LogStore, 'size' | 'read' | 'stream'>,
    @Inject(FLEET_CFG) private readonly cfg: Pick<IFleetConfig, 'logScanBytes'>,
  ) {}

  /** Spec §3.1: every attempt with rows or `log` events, latest first. */
  async list(projectId: string, jobId: string): Promise<{ attempts: LogAttemptSummary[] }> {
    await this.job(projectId, jobId);
    const [rows, eventEpochs] = await Promise.all([this.logs.listForJob(jobId), this.logs.findLogEventEpochs(jobId)]);
    const epochs = [...new Set([...rows.map((r) => r.leaseEpoch), ...eventEpochs])].sort((a, b) => b - a);
    const order = (s: LogStreamName): number => LOG_STREAMS.indexOf(s);
    return {
      attempts: epochs.map((leaseEpoch) => {
        const streams = rows.filter((r) => r.leaseEpoch === leaseEpoch).sort((a, b) => order(a.stream) - order(b.stream));
        return { leaseEpoch, legacySampled: streams.length === 0 && eventEpochs.includes(leaseEpoch), streams: streams.map(summary) };
      }),
    };
  }

  /** Spec §3.3 (D332-D340). */
  async entries(projectId: string, jobId: string, streamRaw: string, p: EntriesParams): Promise<EntriesPage> {
    const t = await this.target(projectId, jobId, streamRaw, p.leaseEpoch);
    const size = await this.store.size(t.key);
    const complete = t.row?.complete === true;
    const truncated = t.row?.truncated === true;
    const scan = { size, complete, scanBytes: this.cfg.logScanBytes };
    const page = p.direction === 'backward'
      ? await this.pickBackward(t.stream, await this.backwardWindow(t.key, { ...scan, cursor: p.cursor ?? (await this.visibleEndOf(t.key, size, complete)) }), p)
      : await this.pickForward(t.stream, await this.forwardWindow(t.key, { ...scan, cursor: p.cursor ?? 0 }), p);
    return { ...page, size, complete, truncated };
  }

  /** Spec §3.2: `[from, to)` clamped to the size, at most RAW_MAX_BYTES. */
  async raw(projectId: string, jobId: string, streamRaw: string, q: { leaseEpoch?: number; from?: number; to?: number }): Promise<Buffer> {
    const t = await this.target(projectId, jobId, streamRaw, q.leaseEpoch);
    const from = q.from ?? 0;
    const to = q.to ?? from + RAW_MAX_BYTES;
    if (to < from || to - from > RAW_MAX_BYTES) {
      throw new ValidationAppException({ reason: `to - from must be between 0 and ${RAW_MAX_BYTES}` }, 'fleet.logQuery');
    }
    return this.store.read(t.key, from, to);
  }

  /** Spec §3.2 `download=1`: the whole stream. 404 when there is no row and no byte (D332). */
  async download(projectId: string, jobId: string, streamRaw: string, leaseEpoch?: number): Promise<LogDownload> {
    const t = await this.target(projectId, jobId, streamRaw, leaseEpoch);
    const sizeBytes = await this.store.size(t.key);
    const head = { jobId: t.job.id, leaseEpoch: t.leaseEpoch, stream: t.stream, sizeBytes };
    if (sizeBytes === 0) {
      if (!t.row) throw new NotFoundAppException({}, 'fleet.logs');
      return { ...head, body: Readable.from([]) };
    }
    return { ...head, body: await this.store.stream(t.key) };
  }

  private async job(projectId: string, jobId: string): Promise<FleetJobRecord> {
    const job = await this.jobs.findById(jobId);
    if (!job || job.projectId !== projectId) throw new NotFoundAppException({}, 'fleet.jobs');
    return job;
  }

  private async target(projectId: string, jobId: string, streamRaw: string, leaseEpoch: number | undefined): Promise<Target> {
    const job = await this.job(projectId, jobId);
    if (!isLogStream(streamRaw)) throw new ValidationAppException({ reason: 'stream' }, 'fleet.logQuery');
    const epoch = leaseEpoch ?? job.leaseEpoch;
    if (epoch > job.leaseEpoch) throw new NotFoundAppException({}, 'fleet.logs');
    const row = await this.logs.findStream(job.id, epoch, streamRaw);
    if (row?.expiredAt) throw new FleetLogExpiredException();
    return { job, stream: streamRaw, leaseEpoch: epoch, key: logKey(job.id, epoch, streamRaw), row };
  }

  private async visibleEndOf(key: string, size: number, complete: boolean): Promise<number> {
    if (complete) return size;
    const tailStart = Math.max(0, size - this.cfg.logScanBytes);
    return visibleEnd(await this.store.read(key, tailStart, size), tailStart, size, complete);
  }

  private async forwardWindow(key: string, o: ScanOptions): Promise<ScannedWindow> {
    const r = forwardReadRange(o);
    const buf = await this.store.read(key, r.from, r.to);
    return { ...forwardSpans(buf, r.from, o), buf, bufStart: r.from };
  }

  private async backwardWindow(key: string, o: ScanOptions): Promise<ScannedWindow> {
    const r = backwardReadRange(o);
    const buf = await this.store.read(key, r.from, r.to);
    return { ...backwardSpans(buf, r.from, o), buf, bufStart: r.from };
  }

  private async pickForward(stream: LogStreamName, w: ScannedWindow, p: EntriesParams): Promise<Omit<EntriesPage, 'size' | 'complete' | 'truncated'>> {
    const entries: LogEntryView[] = [];
    let stoppedAt: number | null = null;
    let sinceYield = 0;
    for (const span of w.spans) {
      const entry = toEntry(stream, span, w.buf.subarray(span.start - w.bufStart, span.end - w.bufStart), p);
      if (entry) entries.push(entry);
      sinceYield += span.end - span.start;
      if (sinceYield >= YIELD_BYTES) {
        sinceYield = 0;
        await nextTurn();
      }
      if (entries.length === p.limit) {
        stoppedAt = span.end;
        break;
      }
    }
    const nextCursor = stoppedAt ?? w.linesEnd;
    return { entries, nextCursor, scannedFrom: w.linesStart, scannedTo: nextCursor, atEnd: w.reachedEnd && nextCursor === w.linesEnd };
  }

  private async pickBackward(stream: LogStreamName, w: ScannedWindow, p: EntriesParams): Promise<Omit<EntriesPage, 'size' | 'complete' | 'truncated'>> {
    const newestFirst: LogEntryView[] = [];
    let stoppedAt: number | null = null;
    let sinceYield = 0;
    for (const span of [...w.spans].reverse()) {
      const entry = toEntry(stream, span, w.buf.subarray(span.start - w.bufStart, span.end - w.bufStart), p);
      if (entry) newestFirst.push(entry);
      sinceYield += span.end - span.start;
      if (sinceYield >= YIELD_BYTES) {
        sinceYield = 0;
        await nextTurn();
      }
      if (newestFirst.length === p.limit) {
        stoppedAt = span.start;
        break;
      }
    }
    const nextCursor = stoppedAt ?? w.linesStart;
    return { entries: [...newestFirst].reverse(), nextCursor, scannedFrom: nextCursor, scannedTo: w.linesEnd, atEnd: nextCursor === 0 };
  }
}
