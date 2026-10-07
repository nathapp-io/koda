import { describe, expect, test } from '@jest/globals'
import {
  createFile, deleteFile, discardAll, discardFile, draftEdits, draftProblems, editFile, emptyDraft, fileStatus,
  groupFiles, jsonError, resolveConflict, type NaxFileContent, type NaxFileEntry,
} from '~/lib/nax-config'

const loaded = (path: string, content: string, blobSha = `sha-${path}`): NaxFileContent => ({ path, blobSha, content })
const entry = (path: string, group: NaxFileEntry['group']): NaxFileEntry => ({ path, size: 10, blobSha: `sha-${path}`, group })

describe('draft model (S3 §6, D474)', () => {
  test('editing to new content marks modified; editing back to the original drops the entry', () => {
    const file = loaded('.nax/context.md', 'old')
    const d1 = editFile(emptyDraft('base1'), file, 'new')
    expect(fileStatus(d1, '.nax/context.md')).toBe('modified')
    expect(draftEdits(d1)).toEqual([{ path: '.nax/context.md', op: 'put', content: 'new', baseSha: 'sha-.nax/context.md' }])
    const d2 = editFile(d1, file, 'old')
    expect(fileStatus(d2, '.nax/context.md')).toBe('unchanged')
    expect(draftEdits(d2)).toEqual([])
  })

  test('the draft is never mutated', () => {
    const d0 = emptyDraft('base1')
    const d1 = editFile(d0, loaded('.nax/context.md', 'a'), 'b')
    expect(d0.files).toEqual({})
    expect(d1).not.toBe(d0)
  })

  test('a created file is new with a null baseSha; editing it keeps it new', () => {
    const d1 = createFile(emptyDraft('b'), '.nax/rules/style.md', '# Style')
    const d2 = createFile(d1, '.nax/rules/style.md', '# Style v2')
    expect(fileStatus(d2, '.nax/rules/style.md')).toBe('new')
    expect(draftEdits(d2)).toEqual([{ path: '.nax/rules/style.md', op: 'put', content: '# Style v2', baseSha: null }])
  })

  test('createFile refuses a path outside the allowlist, including .env profiles', () => {
    expect(() => createFile(emptyDraft('b'), '.nax/profiles/fast.env', 'X=1')).toThrow('not an allowed nax path')
    expect(() => createFile(emptyDraft('b'), 'README.md', 'x')).toThrow('not an allowed nax path')
  })

  test('deleting an existing file emits a delete without content; deleting a new file just forgets it', () => {
    const d1 = deleteFile(emptyDraft('b'), loaded('.nax/rules/old.md', 'x'))
    expect(fileStatus(d1, '.nax/rules/old.md')).toBe('deleted')
    expect(draftEdits(d1)).toEqual([{ path: '.nax/rules/old.md', op: 'delete', baseSha: 'sha-.nax/rules/old.md' }])
    const d2 = createFile(emptyDraft('b'), '.nax/rules/n.md', 'x')
    const d3 = deleteFile(d2, { path: '.nax/rules/n.md', blobSha: '', content: 'x' })
    expect(fileStatus(d3, '.nax/rules/n.md')).toBe('unchanged')
  })

  test('discardFile and discardAll', () => {
    const d1 = createFile(editFile(emptyDraft('b'), loaded('.nax/context.md', 'a'), 'b'), '.nax/rules/x.md', 'x')
    expect(Object.keys(discardFile(d1, '.nax/context.md').files)).toEqual(['.nax/rules/x.md'])
    expect(discardAll(d1).files).toEqual({})
    expect(discardAll(d1).baseSha).toBe('b')
  })

  test('draftEdits are sorted by path', () => {
    const d = createFile(createFile(emptyDraft('b'), '.nax/rules/z.md', 'z'), '.nax/config.json', '{}')
    expect(draftEdits(d).map((e) => e.path)).toEqual(['.nax/config.json', '.nax/rules/z.md'])
  })
})

describe('problems', () => {
  test('jsonError returns the parser message for invalid JSON and null for valid JSON', () => {
    expect(jsonError('{"a":1}')).toBeNull()
    expect(jsonError('{"a":')).toEqual(expect.any(String))
  })

  test('an invalid .json put is a json problem; a .md file is never parsed', () => {
    const d = createFile(createFile(emptyDraft('b'), '.nax/config.json', '{oops'), '.nax/context.md', '{oops')
    expect(draftProblems(d)).toEqual([{ path: '.nax/config.json', code: 'json' }])
  })

  test('limits: 50 edits, 256 KiB per file (bytes, not chars), 1 MiB total', () => {
    let many = emptyDraft('b')
    for (let i = 0; i < 51; i += 1) many = createFile(many, `.nax/rules/r${i}.md`, 'x')
    expect(draftProblems(many)).toContainEqual({ path: null, code: 'too_many' })
    // 87 382 three-byte characters = 262 146 bytes > 262 144
    const big = createFile(emptyDraft('b'), '.nax/context.md', '中'.repeat(87_382))
    expect(draftProblems(big)).toContainEqual({ path: '.nax/context.md', code: 'file_too_large' })
    let total = emptyDraft('b')
    for (let i = 0; i < 5; i += 1) total = createFile(total, `.nax/rules/t${i}.md`, 'a'.repeat(250_000))
    expect(draftProblems(total)).toContainEqual({ path: null, code: 'total_too_large' })
  })

  test('an unresolved conflict is a problem until resolveConflict', () => {
    const d = { baseSha: 'b', files: { '.nax/context.md': { path: '.nax/context.md', baseSha: 's2', original: 'up', content: 'mine', conflict: true } } }
    expect(draftProblems(d)).toEqual([{ path: '.nax/context.md', code: 'conflict' }])
    expect(draftProblems(resolveConflict(d, '.nax/context.md'))).toEqual([])
  })
})

describe('groupFiles', () => {
  test('groups in fixed order, includes new files, marks status, sorts paths', () => {
    const entries = [entry('.nax/rules/b.md', 'rules'), entry('.nax/config.json', 'config'), entry('.nax/rules/a.md', 'rules')]
    const draft = createFile(editFile(emptyDraft('b'), loaded('.nax/rules/b.md', 'x'), 'y'), '.nax/context.md', '# c')
    expect(groupFiles(entries, draft)).toEqual([
      { group: 'rules', files: [{ path: '.nax/rules/a.md', status: 'unchanged' }, { path: '.nax/rules/b.md', status: 'modified' }] },
      { group: 'context', files: [{ path: '.nax/context.md', status: 'new' }] },
      { group: 'config', files: [{ path: '.nax/config.json', status: 'unchanged' }] },
    ])
  })
})

describe('review focus (S3 plan)', () => {
  const crlf: NaxFileContent = { path: '.nax/context.md', blobSha: 'b1', content: '# ctx\r\nline\r\n' }

  test('an unedited CRLF file is never in the edit set (a textarea reports LF)', () => {
    const draft = editFile(emptyDraft('base'), crlf, '# ctx\nline\n')
    expect(draftEdits(draft)).toEqual([])
    expect(fileStatus(draft, crlf.path)).toBe('unchanged')
  })

  test('an edited CRLF file keeps CRLF line endings', () => {
    const draft = editFile(emptyDraft('base'), crlf, '# ctx\nline two\n')
    expect(draftEdits(draft)).toEqual([{ path: crlf.path, op: 'put', content: '# ctx\r\nline two\r\n', baseSha: 'b1' }])
  })

  test('deleting then re-creating the same path is a modify against the loaded blob, not a new file', () => {
    const loaded: NaxFileContent = { path: '.nax/rules/a.md', blobSha: 'b2', content: '# a\n' }
    const draft = createFile(deleteFile(emptyDraft('base'), loaded), loaded.path, '# a again\n')
    expect(fileStatus(draft, loaded.path)).toBe('modified')
    expect(draftEdits(draft)).toEqual([{ path: loaded.path, op: 'put', content: '# a again\n', baseSha: 'b2' }])
  })
})

import { newFileTargets, reapplyEdits, validateNewPath, type NaxFileList } from '~/lib/nax-config'

describe('new file targets (S3 §6 "New file")', () => {
  test('suggests missing root files, a rule, a profile, and missing files of known mono packages', () => {
    const entries = [entry('.nax/context.md', 'context'), entry('.nax/mono/apps/api/context.md', 'context')]
    expect(newFileTargets(entries)).toEqual([
      '.nax/rules/new-rule.md',
      '.nax/config.json',
      '.nax/constitution.md',
      '.nax/mono/apps/api/config.json',
      '.nax/profiles/new-profile.json',
    ])
  })

  test('validateNewPath refuses disallowed and existing paths', () => {
    expect(validateNewPath('.nax/rules/x.md', [])).toBeNull()
    expect(validateNewPath('.nax/profiles/p.env', [])).toBe('not_allowed')
    expect(validateNewPath('.nax/Rules/x.md', [])).toBe('not_allowed')
    expect(validateNewPath('.nax/rules/x.md', ['.nax/rules/x.md'])).toBe('exists')
  })
})

describe('reapplyEdits (S3 §6 "Reopen edits")', () => {
  const latest: NaxFileList = {
    baseSha: 'head2',
    defaultBranch: 'main',
    files: [
      { path: '.nax/context.md', size: 3, blobSha: 'ctx-v2', group: 'context' },
      { path: '.nax/rules/a.md', size: 3, blobSha: 'a-v1', group: 'rules' },
      { path: '.nax/rules/taken.md', size: 3, blobSha: 't-v1', group: 'rules' },
    ],
  }
  const contents = {
    '.nax/context.md': { path: '.nax/context.md', blobSha: 'ctx-v2', content: 'upstream' },
    '.nax/rules/a.md': { path: '.nax/rules/a.md', blobSha: 'a-v1', content: 'a' },
    '.nax/rules/taken.md': { path: '.nax/rules/taken.md', blobSha: 't-v1', content: 't' },
  }

  test('an unchanged base re-applies cleanly; a changed base is flagged with both versions kept', () => {
    const draft = reapplyEdits([
      { path: '.nax/rules/a.md', op: 'put', content: 'a2', baseSha: 'a-v1' },
      { path: '.nax/context.md', op: 'put', content: 'mine', baseSha: 'ctx-v1' },
    ], latest, contents)
    expect(draft.baseSha).toBe('head2')
    expect(draft.files['.nax/rules/a.md']).toEqual({ path: '.nax/rules/a.md', baseSha: 'a-v1', original: 'a', content: 'a2', conflict: false })
    expect(draft.files['.nax/context.md']).toEqual({ path: '.nax/context.md', baseSha: 'ctx-v2', original: 'upstream', content: 'mine', conflict: true })
  })

  test('a new file whose path now exists upstream is a conflict against the upstream file', () => {
    const draft = reapplyEdits([{ path: '.nax/rules/taken.md', op: 'put', content: 'mine', baseSha: null }], latest, contents)
    expect(draft.files['.nax/rules/taken.md']).toMatchObject({ baseSha: 't-v1', original: 't', content: 'mine', conflict: true })
  })

  test('an edited file deleted upstream comes back as a flagged new file; a delete of a gone file is dropped', () => {
    const draft = reapplyEdits([
      { path: '.nax/rules/gone.md', op: 'put', content: 'mine', baseSha: 'g-v1' },
      { path: '.nax/rules/also-gone.md', op: 'delete', baseSha: 'x-v1' },
    ], latest, contents)
    expect(draft.files['.nax/rules/gone.md']).toEqual({ path: '.nax/rules/gone.md', baseSha: null, original: null, content: 'mine', conflict: true })
    expect(draft.files['.nax/rules/also-gone.md']).toBeUndefined()
  })

  test('a stored path outside the allowlist is dropped (defence in depth)', () => {
    const draft = reapplyEdits([{ path: '.nax/profiles/p.env', op: 'put', content: 'X=1', baseSha: null }], latest, contents)
    expect(draft.files).toEqual({})
  })
})
