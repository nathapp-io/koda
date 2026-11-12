import { describe, expect, test } from '@jest/globals'
import { readFileSync } from 'node:fs'
import { webFile } from '../helpers/mount-sfc'
import { FILTER_CONTROL_CLASS } from '../../lib/form-control'

function source(...parts: string[]): string {
  return readFileSync(webFile(...parts), 'utf8')
}

function selectWithId(text: string, id: string): string {
  const tag = text.match(new RegExp(`<select(?=[^>]*(?:\\bid="${id}"|data-testid="${id}"))[^>]*>`))?.[0]
  expect(tag).toBeDefined()
  return tag ?? ''
}

describe('remaining raw select heights', () => {
  test('shared filter control is the specified 40px base', () => {
    expect(FILTER_CONTROL_CLASS).toBe('h-10 rounded-md border border-input bg-background px-3 text-sm')
  })
  test('BackendPicker uses shared 40px controls on all three selects', () => {
    const text = source('components', 'fleet', 'threads', 'BackendPicker.vue')
    for (const id of ['thread-backend-agent', 'thread-backend-model', 'thread-backend-effort']) {
      expect(selectWithId(text, id)).toContain('FILTER_CONTROL_CLASS')
      expect(selectWithId(text, id)).toContain('w-full')
      expect(selectWithId(text, id)).not.toContain('h-9')
    }
  })
  test('ApprovalPolicyDialog uses shared controls for the scoped selects', () => {
    const text = source('components', 'approvals', 'ApprovalPolicyDialog.vue')
    for (const id of ['policy-subject-kind', 'policy-principal-type', 'policy-role', 'policy-mode', 'policy-on-timeout']) {
      expect(selectWithId(text, id)).toContain('FILTER_CONTROL_CLASS')
      expect(selectWithId(text, id)).toContain('w-full')
      expect(selectWithId(text, id)).not.toContain('h-9')
    }
  })
  test('ProjectMembersPanel preserves its width exception and standardizes four selects', () => {
    const text = source('components', 'ProjectMembersPanel.vue')
    for (const id of ['member-add-role', 'agent-add-select', 'agent-add-role', 'member-chip-add-role']) {
      expect(selectWithId(text, id)).toContain('FILTER_CONTROL_CLASS')
    }
    expect(selectWithId(text, 'agent-add-select')).toContain('max-w-xs')
  })
  test('role, principal and invite selects use shared controls', () => {
    const specs = [
      [['components', 'RoleEditorDialog.vue'], 'role-scope'],
      [['components', 'PrincipalRolesDialog.vue'], 'binding-role-select'],
      [['components', 'ProjectInvitesPanel.vue'], 'invite-role'],
    ] as const
    for (const [path, id] of specs) expect(selectWithId(source(...path), id)).toContain('FILTER_CONTROL_CLASS')
  })
  test('agent roster status select uses shared height and retains disabled styles', () => {
    const text = source('pages', '[project]', 'agents.vue')
    const tag = text.match(/<select(?=[^>]*disabled:opacity-50)[^>]*>/)?.[0] ?? ''
    expect(tag).toContain('FILTER_CONTROL_CLASS')
    expect(tag).toContain('disabled:opacity-50')
    expect(tag).toContain('disabled:cursor-not-allowed')
    expect(tag).not.toContain('h-8')
  })
  test('roster status failure path restores the refreshed ACTIVE state', () => {
    const text = source('pages', '[project]', 'agents.vue')
    expect(text).toMatch(/onStatusChange/)
    expect(text).toMatch(/catch/)
    expect(text).toMatch(/if \(select\) select\.value = agent\.status/)
    expect(text).toMatch(/await refresh\(\)/)
  })
})
