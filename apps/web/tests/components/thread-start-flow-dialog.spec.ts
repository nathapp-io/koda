import { describe, expect, test } from '@jest/globals'
import * as Vue from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { FakeNode } from '../helpers/mount-sfc'
import { uiStubs } from '../helpers/fleet-harness'
import type { ThreadDetailDto } from '~/lib/thread-types'

const thread = (over: Record<string, unknown> = {}): ThreadDetailDto => ({ id:'t', repoId:'r', baseRef:'main', feature:'f-min', title:'title', createdById:'u', runnerId:'r', backend:{kind:'native',model:'x'}, status:'ACTIVE', archivedAt:null, skills:[], maxCostUsd:'5', costUsd:'0', tokens:null, specPath:'.nax/features/f-min/spec.md', pendingQuestion:null, session:null, lastActivityAt:'', createdAt:'', activeJob:null, sendRefusal:null, writtenPaths:[], publishedSha:null, specPublished:true, lastWrite:{kind:'published',paths:['.nax/features/f-clamp/spec.md']}, handoff:{plan:null,run:null}, ...over })
const t = (key: string) => key
const mount = (th = thread(), open = true) => mountSfc(webFile('components','fleet','threads','ThreadStartFlowDialog.vue'), {props:{open,thread:th,viewerId:'u'},components:uiStubs,globals:{useI18n:()=>({t})}})
const settle = async () => { for(let i=0;i<4;i++){await Vue.nextTick(); await new Promise(r=>setImmediate(r))} }
const rows = (app: ReturnType<typeof mount>) => app.find('[data-testid="flow-start-row"]')
const input = (app: ReturnType<typeof mount>, row: FakeNode, id: string) => app.find(`[data-testid="${id}"]`,row)[0]
const click = (n: FakeNode | undefined) => { const fn=n?.props.onClick; if(typeof fn==='function') (fn as ()=>void)() }
const change = (n: FakeNode | undefined, value: string) => { const fn=n?.props['onUpdate:modelValue']; if(typeof fn==='function') (fn as (v:string)=>void)(value) }
describe('US-006 ThreadStartFlowDialog rows',()=>{
 test('AC-1..4 prefill own and published feature rows and prior dependency',()=>{const app=mount();expect(rows(app)).toHaveLength(2);const r=rows(app)[1]!;expect(input(app,r,'flow-start-feature')?.props.modelValue).toBe('f-clamp');expect(input(app,r,'flow-start-spec-path')?.props.modelValue).toBe('.nax/features/f-clamp/spec.md');expect(app.find('[data-testid="flow-start-dependency"]',r)[0]?.props.checked).toBe(true);app.unmount()})
 test('AC-5..7 dependency checkboxes only refer to earlier rows',()=>{const app=mount(thread({feature:'a',specPath:'.nax/features/a/spec.md',lastWrite:{kind:'published',paths:['.nax/features/b/spec.md','.nax/features/c/spec.md']}}));expect(app.find('[data-testid="flow-start-dependency"]',rows(app)[0])).toHaveLength(0);expect(app.find('[data-testid="flow-start-dependency"]',rows(app)[2])).toHaveLength(2);expect(app.find('[data-testid="flow-start-dependency"]',rows(app)[2]).map(n=>n.props.value)).toEqual(['a','b']);app.unmount()})
 test('AC-8..9 add row blank and unchecked',()=>{const app=mount();click(app.one('[data-testid="flow-start-add-row"]'));const r=rows(app)[2]!;expect(input(app,r,'flow-start-feature')?.props.modelValue).toBe('');expect(app.find('[data-testid="flow-start-dependency"]',r).every(n=>n.props.checked===false)).toBe(true);app.unmount()})
 test('AC-10 remove row',()=>{const app=mount();click(app.find('[data-testid="flow-start-remove-row"]')[1]);expect(rows(app)).toHaveLength(1);app.unmount()})
 test('AC-11 removing feature clears later dependency',()=>{const app=mount(thread({feature:'a',specPath:'.nax/features/a/spec.md',lastWrite:{kind:'published',paths:['.nax/features/b/spec.md','.nax/features/c/spec.md']}}));const check=app.find('[data-testid="flow-start-dependency"]',rows(app)[2])[0]!; (check.props.onChange as (e:{target:{checked:boolean}})=>void)({target:{checked:true}});click(app.find('[data-testid="flow-start-remove-row"]')[0]);expect(app.find('[data-testid="flow-start-dependency"]',rows(app)[1]).every(n=>n.props.checked===false)).toBe(true);app.unmount()})
 test('AC-12 rename updates checked dependency label',()=>{const app=mount();change(input(app,rows(app)[0]!, 'flow-start-feature'),'f-low');expect(app.find('[data-testid="flow-start-dependency"]',rows(app)[1]!).map(n=>n.props.value)).toContain('f-low');expect(app.find('[data-testid="flow-start-dependency"]',rows(app)[1]!)[0]?.props.checked).toBe(true);app.unmount()})
 test('AC-13..14 reset on reopen and forward close',async()=>{const app=mount();click(app.one('[data-testid="flow-start-add-row"]'));app.setProps({open:false});await settle();app.setProps({open:true});await settle();expect(rows(app)).toHaveLength(2);app.find('[data-testid="flow-start-dialog"]')[0]?.props.onUpdateOpen?.(false);expect(app.emitted('update:open')).toEqual([[false]]);app.unmount()})
 test('AC-15 failed publish does not add published paths',()=>{const app=mount(thread({lastWrite:{kind:'publish_failed',paths:['.nax/features/f-clamp/spec.md']}}));expect(rows(app)).toHaveLength(1);app.unmount()})
})
