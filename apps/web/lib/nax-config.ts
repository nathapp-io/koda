/**
 * S3 §6: the config page's data model. Wire types mirror the API (spec §4.1); the allowlist and limits are the shared
 * protocol module (D467), so the web refuses exactly what the API and runner refuse. Every function returns a new
 * draft (D474: the draft is page state only).
 */
import {
  isAllowedNaxPath, NAX_CONFIG_LIMITS, naxPathGroup, type ConfigFileEdit, type NaxPathGroup,
} from '@nathapp/fleet-protocol'

export interface NaxFileEntry { path: string; size: number; blobSha: string; group: NaxPathGroup }
export interface NaxFileList { baseSha: string; defaultBranch: string; files: NaxFileEntry[] }
export interface NaxFileContent { path: string; blobSha: string; content: string }

export type DraftStatus = 'unchanged' | 'modified' | 'new' | 'deleted'

/** `original` null = a new file; `content` null = deleted; `conflict` = upstream changed under a reopened edit. */
export interface DraftFile { path: string; baseSha: string | null; original: string | null; content: string | null; conflict: boolean }
export interface ConfigDraft { baseSha: string; files: Readonly<Record<string, DraftFile>> }

export const emptyDraft = (baseSha: string): ConfigDraft => ({ baseSha, files: {} })

const withFile = (draft: ConfigDraft, file: DraftFile): ConfigDraft => ({ ...draft, files: { ...draft.files, [file.path]: file } })

const withoutFile = (draft: ConfigDraft, path: string): ConfigDraft => ({
  ...draft,
  files: Object.fromEntries(Object.entries(draft.files).filter(([key]) => key !== path)),
})

function assertAllowed(path: string): void {
  if (!isAllowedNaxPath(path)) throw new Error(`${path} is not an allowed nax path`)
}

/** Browsers report textarea values with LF; keep the file's own CRLF endings so an unedited file stays unchanged. */
const matchLineEndings = (original: string | null, content: string): string =>
  original !== null && original.includes('\r\n') && !content.includes('\r') ? content.replace(/\n/g, '\r\n') : content

export function editFile(draft: ConfigDraft, loaded: NaxFileContent, input: string): ConfigDraft {
  const current = draft.files[loaded.path]
  if (current && current.original === null) return withFile(draft, { ...current, content: input })
  const original = current?.original ?? loaded.content
  const baseSha = current?.baseSha ?? loaded.blobSha
  const content = matchLineEndings(original, input)
  if (content === original && !current?.conflict) return withoutFile(draft, loaded.path)
  return withFile(draft, { path: loaded.path, baseSha, original, content, conflict: current?.conflict ?? false })
}

export function createFile(draft: ConfigDraft, path: string, content: string): ConfigDraft {
  assertAllowed(path)
  const current = draft.files[path]
  // Re-creating a file this draft deleted is a modify of the loaded blob (otherwise the runner sees baseSha null
  // for an existing path and reports a conflict).
  if (current && current.original !== null) {
    const next = matchLineEndings(current.original, content)
    return next === current.original && !current.conflict
      ? withoutFile(draft, path)
      : withFile(draft, { ...current, content: next })
  }
  return withFile(draft, { path, baseSha: null, original: null, content, conflict: current?.conflict ?? false })
}

export function deleteFile(draft: ConfigDraft, loaded: NaxFileContent): ConfigDraft {
  const current = draft.files[loaded.path]
  if (current && current.original === null) return withoutFile(draft, loaded.path)
  return withFile(draft, {
    path: loaded.path, baseSha: current?.baseSha ?? loaded.blobSha, original: current?.original ?? loaded.content, content: null, conflict: false,
  })
}

export const discardFile = (draft: ConfigDraft, path: string): ConfigDraft => withoutFile(draft, path)
export const discardAll = (draft: ConfigDraft): ConfigDraft => emptyDraft(draft.baseSha)

export function resolveConflict(draft: ConfigDraft, path: string): ConfigDraft {
  const current = draft.files[path]
  return current ? withFile(draft, { ...current, conflict: false }) : draft
}

export function fileStatus(draft: ConfigDraft, path: string): DraftStatus {
  const file = draft.files[path]
  if (!file) return 'unchanged'
  if (file.content === null) return 'deleted'
  return file.original === null ? 'new' : 'modified'
}

export function draftEdits(draft: ConfigDraft): ConfigFileEdit[] {
  return Object.values(draft.files)
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((file): ConfigFileEdit => (file.content === null
      ? { path: file.path, op: 'delete', baseSha: file.baseSha }
      : { path: file.path, op: 'put', content: file.content, baseSha: file.baseSha }))
}

export function jsonError(content: string): string | null {
  try {
    JSON.parse(content)
    return null
  }
  catch (err: unknown) {
    return err instanceof Error ? err.message : String(err)
  }
}

export interface DraftProblem { path: string | null; code: 'json' | 'too_many' | 'file_too_large' | 'total_too_large' | 'conflict' }

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length

export function draftProblems(draft: ConfigDraft): DraftProblem[] {
  const files = Object.values(draft.files).slice().sort((a, b) => a.path.localeCompare(b.path))
  const perFile = files.flatMap((file): DraftProblem[] => {
    const problems: DraftProblem[] = []
    if (file.conflict) problems.push({ path: file.path, code: 'conflict' })
    if (file.content === null) return problems
    if (utf8Bytes(file.content) > NAX_CONFIG_LIMITS.maxFileBytes) problems.push({ path: file.path, code: 'file_too_large' })
    if (file.path.endsWith('.json') && jsonError(file.content) !== null) problems.push({ path: file.path, code: 'json' })
    return problems
  })
  const total = files.reduce((sum, file) => sum + (file.content === null ? 0 : utf8Bytes(file.content)), 0)
  return [
    ...perFile,
    ...(files.length > NAX_CONFIG_LIMITS.maxEdits ? [{ path: null, code: 'too_many' } as DraftProblem] : []),
    ...(total > NAX_CONFIG_LIMITS.maxTotalBytes ? [{ path: null, code: 'total_too_large' } as DraftProblem] : []),
  ]
}

export const NAX_GROUP_ORDER: readonly NaxPathGroup[] = ['rules', 'context', 'config', 'profiles', 'constitution']

export interface TreeGroup { group: NaxPathGroup; files: Array<{ path: string; status: DraftStatus }> }

export function groupFiles(entries: readonly NaxFileEntry[], draft: ConfigDraft): TreeGroup[] {
  const paths = [...new Set([...entries.map((e) => e.path), ...Object.keys(draft.files)])]
  return NAX_GROUP_ORDER
    .map((group) => ({
      group,
      files: paths
        .filter((path) => naxPathGroup(path) === group)
        .sort((a, b) => a.localeCompare(b))
        .map((path) => ({ path, status: fileStatus(draft, path) })),
    }))
    .filter((g) => g.files.length > 0)
}

const ROOT_FILES = ['.nax/config.json', '.nax/constitution.md'] as const
const MONO_FILE = /^\.nax\/mono\/(.+)\/(context\.md|config\.json)$/

/** Suggested paths for "New file": a rule, missing root files, missing files of known mono packages, a profile. */
export function newFileTargets(entries: readonly NaxFileEntry[]): string[] {
  const existing = new Set(entries.map((e) => e.path))
  const packages = [...new Set(entries.map((e) => MONO_FILE.exec(e.path)?.[1]).filter((p): p is string => p !== undefined))].sort()
  const monoMissing = packages.flatMap((pkg) => ['context.md', 'config.json'].map((name) => `.nax/mono/${pkg}/${name}`)).filter((p) => !existing.has(p))
  const rootMissing = ['.nax/context.md', ...ROOT_FILES].filter((p) => !existing.has(p))
  return ['.nax/rules/new-rule.md', ...rootMissing, ...monoMissing, '.nax/profiles/new-profile.json']
}

export function validateNewPath(path: string, existing: readonly string[]): 'not_allowed' | 'exists' | null {
  if (!isAllowedNaxPath(path)) return 'not_allowed'
  return existing.includes(path) ? 'exists' : null
}

function reapplyOne(edit: ConfigFileEdit, latest: NaxFileList, contents: Readonly<Record<string, NaxFileContent>>): DraftFile | null {
  if (!isAllowedNaxPath(edit.path)) return null
  const current = latest.files.find((f) => f.path === edit.path)
  if (edit.op === 'delete') {
    if (!current) return null
    return { path: edit.path, baseSha: current.blobSha, original: contents[edit.path]?.content ?? '', content: null, conflict: current.blobSha !== edit.baseSha }
  }
  const content = edit.content ?? ''
  if (!current) return { path: edit.path, baseSha: null, original: null, content, conflict: edit.baseSha !== null }
  const original = contents[edit.path]?.content ?? ''
  const conflict = current.blobSha !== edit.baseSha
  if (!conflict && content === original) return null
  return { path: edit.path, baseSha: current.blobSha, original, content, conflict }
}

/** Re-applies a failed job's stored edits on the latest files; a file whose base moved is flagged, never merged. */
export function reapplyEdits(
  stored: readonly ConfigFileEdit[], latest: NaxFileList, contents: Readonly<Record<string, NaxFileContent>>,
): ConfigDraft {
  const files = stored.map((edit) => reapplyOne(edit, latest, contents)).filter((f): f is DraftFile => f !== null)
  return { baseSha: latest.baseSha, files: Object.fromEntries(files.map((f) => [f.path, f])) }
}
