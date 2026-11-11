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
const required = <T>(value: T | undefined): T => { if (value === undefined) throw new Error('expected node'); return value }
const input = (app: ReturnType<typeof mount>, row: FakeNode, id: string) => app.find(`[data-testid="${id}"]`,row)[0]
const click = (n: FakeNode | undefined) => { const fn=n?.props.onClick; if(typeof fn==='function') (fn as ()=>void)() }
const change = (n: FakeNode | undefined, value: string) => { const fn=n?.props.onInput; if(typeof fn==='function') (fn as (e:{target:{value:string}})=>void)({target:{value}}) }
describe('US-006 ThreadStartFlowDialog rows',()=>{
 test('AC-1..4 prefill own and published feature rows and prior dependency',()=>{const app=mount();expect(rows(app)).toHaveLength(2);const r=required(rows(app)[1]);expect(input(app,r,'flow-start-feature')?.props.value).toBe('f-clamp');expect(input(app,r,'flow-start-spec-path')?.props.value).toBe('.nax/features/f-clamp/spec.md');expect(app.find('[data-testid="flow-start-dependency"]',r)[0]?.props.checked).toBe(true);app.unmount()})
 test('AC-5..7 dependency checkboxes only refer to earlier rows',()=>{const app=mount(thread({feature:'a',specPath:'.nax/features/a/spec.md',lastWrite:{kind:'published',paths:['.nax/features/b/spec.md','.nax/features/c/spec.md']}}));expect(app.find('[data-testid="flow-start-dependency"]',rows(app)[0])).toHaveLength(0);expect(app.find('[data-testid="flow-start-dependency"]',rows(app)[2])).toHaveLength(2);expect(app.find('[data-testid="flow-start-dependency"]',rows(app)[2]).map(n=>n.props.value)).toEqual(['a','b']);app.unmount()})
 test('AC-8..9 add row blank and unchecked',async()=>{const app=mount();click(app.one('[data-testid="flow-start-add-row"]'));await settle();const r=required(rows(app).at(-1));expect(input(app,r,'flow-start-feature')?.props.value).toBe('');expect(app.find('[data-testid="flow-start-dependency"]',r).every(n=>n.props.checked===false)).toBe(true);app.unmount()})
 test('AC-10 remove row',async()=>{const app=mount();click(app.find('[data-testid="flow-start-remove-row"]',rows(app)[1])[0]);await settle();expect(rows(app)).toHaveLength(1);app.unmount()})
 test('AC-11 removing feature clears later dependency',async()=>{const app=mount(thread({feature:'a',specPath:'.nax/features/a/spec.md',lastWrite:{kind:'published',paths:['.nax/features/b/spec.md','.nax/features/c/spec.md']}}));const cChecks=app.find('[data-testid="flow-start-dependency"]',rows(app)[2]);const check=required(cChecks.find(n=>n.props.value==='a')); (check.props.onChange as (e:{target:{checked:boolean}})=>void)({target:{checked:true}});const bCheck=required(cChecks.find(n=>n.props.value==='b'));(bCheck.props.onChange as (e:{target:{checked:boolean}})=>void)({target:{checked:false}});await settle();click(app.find('[data-testid="flow-start-remove-row"]',rows(app)[0])[0]);await settle();const cRow=app.find('[data-testid="flow-start-dependency-row"]').find(n=>n.props['data-feature']==='c');expect(cRow).toBeDefined();expect(app.find('[data-testid="flow-start-dependency"]',required(cRow)).map(n=>n.props.checked)).toEqual([false]);app.unmount()})
 test('AC-12 rename updates checked dependency label',async()=>{const app=mount();change(input(app,required(rows(app)[0]), 'flow-start-feature'),'f-low');await settle();expect(app.find('[data-testid="flow-start-dependency"]',required(rows(app)[1])).map(n=>n.props.value)).toContain('f-low');expect(app.find('[data-testid="flow-start-dependency"]',required(rows(app)[1]))[0]?.props.checked).toBe(true);app.unmount()})
 test('AC-12 rename never retargets a later dependency that passed through another row name',async()=>{const app=mount(thread({feature:'a',specPath:'.nax/features/a/spec.md',backend:{kind:'native',model:'m'},lastWrite:{kind:'published',paths:['.nax/features/b/spec.md','.nax/features/c/spec.md']}}));change(input(app,required(rows(app)[0]),'flow-start-feature'),'b');await settle();change(input(app,required(rows(app)[0]),'flow-start-feature'),'b2');await settle();const deps=app.find('[data-testid="flow-start-dependency"]',required(rows(app)[2]));expect(deps.map(n=>[n.props.value,n.props.checked])).toEqual([['b2',false],['b',true]]);const form=app.one('[data-testid="flow-start-form"]');(form?.props.onSubmit as (e:Event)=>void)({preventDefault:()=>undefined} as unknown as Event);await settle();expect(app.emitted('submit')).toEqual([[{features:[{feature:'b2',specPath:'.nax/features/a/spec.md',dependsOn:[]},{feature:'b',specPath:'.nax/features/b/spec.md',dependsOn:['b2']},{feature:'c',specPath:'.nax/features/c/spec.md',dependsOn:['b']}],roles:{reviewer:'m',supervisor:'m'},costCapUsd:5}]]);app.unmount()})
 test('bounds its height and scrolls its content so long forms stay reachable',()=>{const app=mount();const content=app.one('[data-stub="dialog-content"]');const classes=String(content?.props.class??'');expect(classes).toContain('max-h-[85vh]');expect(classes).toContain('overflow-y-auto');app.unmount()})
 test('keeps the height bound at the supported 20-row maximum',()=>{const paths=Array.from({length:19},(_,i)=>`.nax/features/f-${i}/spec.md`);const app=mount(thread({feature:'a',specPath:'.nax/features/a/spec.md',lastWrite:{kind:'published',paths}}));expect(rows(app)).toHaveLength(20);expect(String(app.one('[data-stub="dialog-content"]')?.props.class??'')).toContain('max-h-[85vh]');expect(app.one('[data-testid="flow-start-submit"]')).toBeDefined();app.unmount()})
 test('AC-13..14 reset on reopen and forward close',async()=>{const app=mount();click(app.one('[data-testid="flow-start-add-row"]'));app.setProps({open:false});await settle();app.setProps({open:true});await settle();expect(rows(app)).toHaveLength(2);app.find('[data-stub="dialog"]')[0]?.props['onUpdate:open']?.(false);expect(app.emitted('update:open')).toEqual([[false]]);app.unmount()})
 test('AC-15 failed publish does not add published paths',()=>{const app=mount(thread({lastWrite:{kind:'publish_failed',paths:['.nax/features/f-clamp/spec.md']}}));expect(rows(app)).toHaveLength(1);app.unmount()})
})
describe('#434 ThreadStartFlowDialog accessible names',()=>{
 const labels=(app: ReturnType<typeof mount>)=>app.find('[data-stub="label"]').filter(n=>n.props.for!==undefined)
 const labelFor=(app: ReturnType<typeof mount>, id: string)=>labels(app).find(n=>n.props.for===id)
 test('every named field has a label whose for matches the input id, unique per row',()=>{
  const app=mount()
  const rowNodes=rows(app)
  expect(rowNodes).toHaveLength(2)
  const ids: string[]=[]
  for(const [index,row] of rowNodes.entries()){
   for(const testid of ['flow-start-feature','flow-start-spec-path']){
    const id=input(app,row,testid)?.props.id
    expect(typeof id).toBe('string')
    expect(labelFor(app,String(id))).toBeDefined()
    ids.push(String(id))
    expect(String(id)).toContain(String(index))
   }
  }
  for(const testid of ['flow-start-reviewer','flow-start-supervisor','flow-start-cost-cap']){
   const id=app.one(`[data-testid="${testid}"]`)?.props.id
   expect(typeof id).toBe('string')
   expect(labelFor(app,String(id))).toBeDefined()
   ids.push(String(id))
  }
  expect(new Set(ids).size).toBe(ids.length)
  app.unmount()
 })
 test('cost cap declares the API bounds: min 0.0001, max 1000, step 0.0001',()=>{
  const app=mount()
  const cap=app.one('[data-testid="flow-start-cost-cap"]')
  expect(cap?.props.type).toBe('number')
  expect(cap?.props.min).toBe(0.0001)
  expect(cap?.props.max).toBe(1000)
  expect(cap?.props.step).toBe(0.0001)
  app.unmount()
 })
})
