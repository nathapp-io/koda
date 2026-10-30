import { describe, expect, test } from '@jest/globals'
import * as Vue from 'vue'
import { computed, ref } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n } from '../helpers/fleet-harness'
import { projectPermissionsStub } from '../helpers/permission-nav'

/**
 * P3b US-006 AC-8/AC-9: the project block's two engine links.
 *
 * `useProjectPermissions(slug)` takes a fixed slug, so the layout cannot read a route's project keys
 * itself. This child owns that read, and the layout mounts it keyed by the route's slug — so a project
 * change is a fresh read of that project's keys. The gates are the keys the two pages need:
 * `approval.decide` (any narrowed pattern counts, which `has()` cannot answer) and
 * `approval.policy.read`.
 */
const navLinks = webFile('components', 'approvals', 'ProjectApprovalNavLinks.vue')

/** The sidebar's links are `NuxtLink`s; the stub renders the href so a test reads the target. */
const NuxtLink = {
  name: 'NuxtLink',
  props: { to: { type: String, required: true }, activeClass: { type: String, default: '' } },
  setup(props: { to: string; activeClass: string }, { slots }: { slots: { default?: () => unknown } }) {
    return () => Vue.h('a', { href: props.to, 'data-active-class': props.activeClass }, slots.default?.() as never)
  },
}

function mountLinks(slug: string, projectKeys: readonly string[]) {
  const app = mountSfc(navLinks, {
    components: { NuxtLink },
    props: { slug },
    globals: {
      ref,
      computed,
      useI18n: () => enI18n(),
      useProjectPermissions: () => projectPermissionsStub(projectKeys),
    },
  })
  const anchors = () => app.find('a')
  const hrefs = (): string[] => anchors().map((node) => String(node.props.href))
  return { app, anchors, hrefs, text: (href: string): string => {
    const node = anchors().find((candidate) => candidate.props.href === href)
    if (!node) throw new Error(`no link to ${href} in: ${app.text()}`)
    return app.textOf(node)
  } }
}

describe('us-006 AC-8: the project inbox link follows the project decide keys', () => {
  test('AC-8: a project set that may decide renders /sandbox/approvals', () => {
    const m = mountLinks('sandbox', ['approval.decide'])

    expect(m.hrefs()).toContain('/sandbox/approvals')
    expect(m.text('/sandbox/approvals')).toBe('Approvals')
    m.app.unmount()
  })

  test('AC-8: a narrowed decide key counts, because the engine grants decide per pattern', () => {
    const m = mountLinks('sandbox', ['approval.decide@fleet.*'])

    expect(m.hrefs()).toContain('/sandbox/approvals')
    m.app.unmount()
  })

  test('AC-8 (control): a project set with no decide key renders no inbox link', () => {
    const m = mountLinks('sandbox', ['approval.policy.read', 'fleet.job.dispatch'])

    expect(m.hrefs()).not.toContain('/sandbox/approvals')
    m.app.unmount()
  })
})

describe('us-006 AC-9: the project policy link follows approval.policy.read', () => {
  test('AC-9: a project set holding approval.policy.read renders /sandbox/approval-policies', () => {
    const m = mountLinks('sandbox', ['approval.policy.read'])

    expect(m.hrefs()).toContain('/sandbox/approval-policies')
    expect(m.text('/sandbox/approval-policies')).toBe('Approval policies')
    m.app.unmount()
  })

  test('AC-9 (control): approval.policy.manage is not a read key', () => {
    const m = mountLinks('sandbox', ['approval.policy.manage'])

    expect(m.hrefs()).not.toContain('/sandbox/approval-policies')
    m.app.unmount()
  })

  test('AC-9 (edge): an empty project set renders nothing at all', () => {
    const m = mountLinks('sandbox', [])

    expect(m.anchors()).toHaveLength(0)
    m.app.unmount()
  })
})

describe('us-006: the slug the link points at', () => {
  test('both links are built from the slug prop, inbox first', () => {
    const m = mountLinks('koda', ['approval.decide', 'approval.policy.read'])

    expect(m.hrefs()).toEqual(['/koda/approvals', '/koda/approval-policies'])
    m.app.unmount()
  })

  test('the links carry the sidebar\'s link and active classes', () => {
    const m = mountLinks('koda', ['approval.decide'])

    expect(String(m.anchors()[0]?.props.class)).toContain('rounded-md px-2.5 py-1.5')
    expect(m.anchors()[0]?.props['data-active-class']).toBe('bg-accent text-accent-foreground')
    m.app.unmount()
  })

  test('a project whose key read is still pending shows no link (fail closed)', () => {
    const app = mountSfc(navLinks, {
      components: { NuxtLink },
      props: { slug: 'sandbox' },
      globals: {
        ref,
        computed,
        useI18n: () => enI18n(),
        useProjectPermissions: () => projectPermissionsStub(['approval.decide', 'approval.policy.read'], { pending: true }),
      },
    })

    expect(app.find('a')).toHaveLength(0)
    app.unmount()
  })
})
