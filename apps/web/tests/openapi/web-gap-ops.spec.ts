import { describe, test, expect } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const settingsPath = join(webDir, 'pages', '[project]', 'settings.vue')
const labelsPath = join(webDir, 'pages', '[project]', 'labels.vue')
const ticketPath = join(webDir, 'pages', '[project]', 'tickets', '[ref].vue')
const actionPanelPath = join(webDir, 'components', 'TicketActionPanel.vue')
const commentThreadPath = join(webDir, 'components', 'CommentThread.vue')
const kbPath = join(webDir, 'pages', '[project]', 'kb.vue')

function src(path: string): string {
  return readFileSync(path, 'utf-8')
}

describe('Web OpenAPI gap operations are wired in source', () => {
  test('project settings uses GET/PATCH/DELETE /projects/:slug', () => {
    const source = src(settingsPath)
    expect(source).toContain('$api.get(`/projects/${slug}`)')
    expect(source).toContain('$api.patch(`/projects/${slug}`')
    expect(source).toContain('$api.delete(`/projects/${slug}`)')
  })

  test('comment thread uses DELETE /comments/:id', () => {
    const source = src(commentThreadPath)
    expect(source).toContain('$api.delete(`/comments/${comment.id}`)')
  })

  test('labels page uses PATCH /projects/:slug/labels/:id', () => {
    const source = src(labelsPath)
    expect(source).toContain('$api.patch(`/projects/${slug}/labels/${label.id}`')
  })

  test('ticket detail uses delete/assign endpoints and action panel uses close endpoint', () => {
    const source = src(ticketPath)
    const panelSource = src(actionPanelPath)
    expect(source).toContain('/tickets/${ref}/assign')
    expect(source).toContain('/tickets/${ref}')
    expect(panelSource).toContain("performAction('close')")
  })

  test('ticket detail uses ticket label assign/remove endpoints', () => {
    const source = src(ticketPath)
    expect(source).toContain('/tickets/${ref}/labels')
    expect(source).toContain('/tickets/${ref}/labels/${labelId}')
  })

  test('ticket detail uses ticket link list/create/delete endpoints', () => {
    const source = src(ticketPath)
    expect(source).toContain('/tickets/${ref}/links')
    expect(source).toContain('/tickets/${ref}/links/${linkId}')
  })

  test('kb page uses delete source and optimize endpoints', () => {
    const source = src(kbPath)
    expect(source).toContain('/kb/documents/${sourceId}')
    expect(source).toContain('/kb/optimize')
  })

  test('settings page uses VCS sync-pr endpoint', () => {
    const source = src(settingsPath)
    expect(source).toContain('/vcs/sync-pr')
  })
})
