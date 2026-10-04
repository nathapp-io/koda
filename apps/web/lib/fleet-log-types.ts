/** Fleet S2a (spec §3): the log read routes' shapes, mirrored from apps/api `fleet-job-log.dto.ts`. */
export const LOG_STREAMS = ['run', 'stdout', 'stderr'] as const
export type LogStream = typeof LOG_STREAMS[number]

/** Minimum-level order, lowest first (spec §3.3). */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const
export type LogLevel = typeof LOG_LEVELS[number]

export const isLogStream = (value: unknown): value is LogStream => (LOG_STREAMS as readonly unknown[]).includes(value)
export const isLogLevel = (value: unknown): value is LogLevel => (LOG_LEVELS as readonly unknown[]).includes(value)

export interface FleetJobLogStreamDto {
  stream: LogStream
  sizeBytes: number
  complete: boolean
  truncated: boolean
  source: 'stream' | 'bundle'
  expired: boolean
  updatedAt: string
}

export interface FleetJobLogAttemptDto {
  leaseEpoch: number
  legacySampled: boolean
  streams: FleetJobLogStreamDto[]
}

export interface FleetJobLogListDto {
  /** Latest attempt first. */
  attempts: FleetJobLogAttemptDto[]
}

/** A parsed nax LogEntry, an unparsed run line, or a stdout/stderr line (1c D339). */
export interface FleetJobLogEntryDto {
  offset: number
  length: number
  unparsed?: boolean
  truncatedLine?: boolean
  text?: string
  timestamp?: string
  level?: string
  stage?: string
  storyId?: string
  sessionRole?: string
  message?: string
  data?: unknown
}

export interface FleetJobLogEntriesDto {
  /** Ascending by offset in both directions. */
  entries: FleetJobLogEntryDto[]
  nextCursor: number
  scannedFrom: number
  scannedTo: number
  atEnd: boolean
  size: number
  complete: boolean
  truncated: boolean
}
