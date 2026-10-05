import { describe, test, expect } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const settingsPath = join(webDir, 'pages', '[project]', 'settings.vue')
const labelsPath = join(webDir, 'pages', '[project]', 'labels.vue')
const ticketPath = join(webDir, 'pages', '[project]', 'tickets', '[ref].vue')
const propertiesPath = join(webDir, 'components', 'TicketProperties.vue')
const actionPanelPath = join(webDir, 'components', 'TicketActionPanel.vue')
const commentThreadPath = join(webDir, 'components', 'CommentThread.vue')
const kbPath = join(webDir, 'pages', '[project]', 'kb.vue')

function src(path: string): string {
  return readFileSync(path, 'utf-8')
}

describe('Web OpenAPI gap operations are wired in source', () => {
  test('project settings uses GET/PATCH/DELETE /projects/:slug', () => {
    const source = src(settingsPath)
    expect(source).toContain('$api.get(apiPath`/projects/${slug}`)')
    expect(source).toContain('$api.patch(apiPath`/projects/${slug}`')
    expect(source).toContain('$api.delete(apiPath`/projects/${slug}`)')
  })

  test('comment thread uses DELETE /comments/:id', () => {
    const source = src(commentThreadPath)
    expect(source).toContain('$api.delete(apiPath`/comments/${comment.id}`)')
  })

  test('labels page uses PATCH /projects/:slug/labels/:id', () => {
    const source = src(labelsPath)
    expect(source).toContain('$api.patch(apiPath`/projects/${slug}/labels/${label.id}`')
  })

  test('ticket detail uses delete/assign endpoints and action panel uses close endpoint', () => {
    // 2026-10-05 UX redesign slice 1: assign/label/link mutations moved from
    // the page into components/TicketProperties.vue.
    const source = src(ticketPath)
    const propertiesSource = src(propertiesPath)
    const panelSource = src(actionPanelPath)
    expect(propertiesSource).toContain('/projects/${props.projectSlug}/tickets/${props.ticketRef}/assign')
    expect(source).toContain('/tickets/${ref}')
    expect(panelSource).toContain("openDialog('close')")
  })

  test('ticket detail uses ticket label assign/remove endpoints', () => {
    const propertiesSource = src(propertiesPath)
    expect(propertiesSource).toContain('/projects/${props.projectSlug}/tickets/${props.ticketRef}/labels')
    expect(propertiesSource).toContain('/projects/${props.projectSlug}/tickets/${props.ticketRef}/labels/${labelId}')
  })

  test('ticket detail uses ticket link list/create/delete endpoints', () => {
    const propertiesSource = src(propertiesPath)
    expect(propertiesSource).toContain('/projects/${props.projectSlug}/tickets/${props.ticketRef}/links')
    expect(propertiesSource).toContain('/projects/${props.projectSlug}/tickets/${props.ticketRef}/links/${linkId}')
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
