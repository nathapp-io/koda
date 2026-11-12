import { expect, test } from '@jest/globals'
import { createSSRApp, createRenderer, h, nextTick, ref } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { formatDate, formatDateTime } from '../../lib/format-date-time'
import { useLocalDates } from '../../lib/local-dates'

const iso = '2026-11-10T14:07:45.657Z'
type Node = { tag: string; props: Record<string, unknown>; children: Array<Node | string> }
const renderer = createRenderer<Node, Node>({
  createElement: tag => ({ tag, props: {}, children: [] }),
  createText: text => text,
  createComment: text => text,
  setText: (node, text) => { Object.assign(node, { text }) },
  setElementText: (node, text) => { node.children = [text] },
  patchProp: (node, key, _old, value) => { node.props[key] = value },
  insert: (child, parent, anchor) => {
    const at = anchor ? parent.children.indexOf(anchor) : -1
    if (at < 0) parent.children.push(child)
    else parent.children.splice(at, 0, child)
  },
  remove: (child, parent) => { if (!parent) return; const at = parent.children.indexOf(child); if (at >= 0) parent.children.splice(at, 1) },
  parentNode: () => null,
  nextSibling: () => null,
})
function component(format: 'dateTime' | 'date' = 'dateTime') {
  return { setup() { const dates = useLocalDates({ locale: ref('en') }); return () => h('time', { datetime: iso }, dates[format](iso)) } }
}
test('formats date-only values and leaves invalid input unchanged', async () => {
  const value = formatDate(iso, 'en')
  expect(value).toContain('Nov')
  expect(value).toContain('2026')
  expect(value).not.toMatch(/14:07|02:07|T14/)
  expect(formatDate('not-a-date', 'en')).toBe('not-a-date')
})
test('renders an empty SSR time then fills viewer-local text after mount', async () => {
  expect(await renderToString(createSSRApp(component()))).toBe(`<time datetime="${iso}"></time>`)
  const root: Node = { tag: 'root', props: {}, children: [] }
  const app = renderer.createApp(component())
  app.mount(root)
  const time = root.children[0] as Node
  expect(time.children.join('')).toBe('')
  await nextTick()
  expect(time.children.join('')).toBe(formatDateTime(iso, 'en'))
  app.unmount()
})
test('formats date-only values after mount and handles absent/invalid dates', async () => {
  const root: Node = { tag: 'root', props: {}, children: [] }
  const app = renderer.createApp(component('date'))
  app.mount(root)
  const time = root.children[0] as Node
  await nextTick()
  expect(time.children.join('')).toBe(formatDate(iso, 'en'))
  app.unmount()
  const invalid = renderer.createApp({ setup() { const dates = useLocalDates(undefined); return () => h('div', [dates.dateTime('not-a-date'), '|', dates.date(null)]) } })
  const otherRoot: Node = { tag: 'root', props: {}, children: [] }
  invalid.mount(otherRoot)
  expect((otherRoot.children[0] as Node).children.join('')).toBe('|-')
  await nextTick()
  invalid.unmount()
})
