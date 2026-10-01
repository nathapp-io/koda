/**
 * Mounts a real .vue file in node without a DOM: compiles the SFC with vue/compiler-sfc, transpiles
 * its TypeScript, and renders it through a minimal custom renderer that records element props and
 * event handlers. Enough to fire a native event at an element and observe what the component emits.
 * Only `vue` can be imported by the SFC under test.
 */
import { readFileSync } from 'fs'
import * as ts from 'typescript'
import * as Vue from 'vue'
import type { Component } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'

export interface FakeNode {
  tag: string
  props: Record<string, unknown>
  children: FakeNode[]
  text: string
  parent: FakeNode | null
}

const node = (tag: string, text = ''): FakeNode => ({ tag, props: {}, children: [], text, parent: null })

const renderer = Vue.createRenderer({
  createElement: (tag: string) => node(tag),
  createText: (text: string) => node('#text', text),
  createComment: (text: string) => node('#comment', text),
  setText: (n: FakeNode, text: string) => { n.text = text },
  setElementText: (n: FakeNode, text: string) => { n.children = [node('#text', text)] },
  insert: (child: FakeNode, parent: FakeNode, anchor: FakeNode | null) => {
    child.parent = parent
    const at = anchor ? parent.children.indexOf(anchor) : -1
    parent.children = at < 0 ? [...parent.children, child] : [...parent.children.slice(0, at), child, ...parent.children.slice(at)]
  },
  remove: (child: FakeNode) => {
    if (child.parent) child.parent.children = child.parent.children.filter((c) => c !== child)
  },
  patchProp: (el: FakeNode, key: string, _prev: unknown, next: unknown) => { el.props = { ...el.props, [key]: next } },
  parentNode: (n: FakeNode) => n.parent,
  nextSibling: (n: FakeNode) => {
    if (!n.parent) return null
    return n.parent.children[n.parent.children.indexOf(n) + 1] ?? null
  },
})

function loadComponent(file: string): Component {
  const { descriptor } = parse(readFileSync(file, 'utf-8'), { filename: file })
  const script = compileScript(descriptor, { id: 'test', inlineTemplate: true })
  const js = ts.transpileModule(script.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
  const mod: { exports: Record<string, unknown> } = { exports: {} }
  const requireVue = (id: string): unknown => {
    if (id === 'vue') return Vue
    throw new Error(`mount-sfc: ${file} imports ${id}; only 'vue' is supported`)
  }
  new Function('require', 'module', 'exports', js)(requireVue, mod, mod.exports)
  return mod.exports.default as Component
}

export function mountSfc(file: string, props: Record<string, unknown>): { root: FakeNode; find: (tag: string) => FakeNode[] } {
  const root = node('#root')
  renderer.createApp(loadComponent(file), props).mount(root)
  const find = (tag: string, from: FakeNode = root): FakeNode[] =>
    from.children.flatMap((c) => [...(c.tag === tag ? [c] : []), ...find(tag, c)])
  return { root, find: (tag: string) => find(tag) }
}
