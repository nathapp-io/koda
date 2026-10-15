import { describe, expect, test } from '@jest/globals'
import * as Vue from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { FakeNode } from '../helpers/mount-sfc'
import { i18nStub, uiStubs } from '../helpers/fleet-harness'
import type { ThreadDetailDto } from '~/lib/thread-types'
const thread=(activeJob: ThreadDetailDto['activeJob']=null):ThreadDetailDto=>({id:'t',repoId:'r',baseRef:'main',feature:'f',title:'t',createdById:'u',runnerId:'r',backend:{kind:'native',model:'x'},status:'ACTIVE',archivedAt:null,skills:[],maxCostUsd:'5',costUsd:'0',tokens:null,specPath:'',pendingQuestion:null,session:{jobId:'j',state:'closed',resumed:false,contextReset:false,reason:null,at:'',stale:true},lastActivityAt:'',createdAt:'',activeJob,sendRefusal:null,writtenPaths:[],publishedSha:null,specPublished:false,lastWrite:null,handoff:{plan:null,run:null}})
const mount=(activeJob:ThreadDetailDto['activeJob']=null)=>mountSfc(webFile('components','fleet','threads','ThreadStaleBanner.vue'),{props:{thread:thread(activeJob),messages:[],isCreator:true},components:uiStubs,globals:{useI18n:()=>i18nStub()}})
const click=(n:FakeNode|undefined)=>{if(typeof n?.props.onClick==='function')(n.props.onClick as ()=>void)()}
const settle=async()=>{for(let i=0;i<4;i++){await new Promise(r=>setImmediate(r));await Vue.nextTick()}}
describe('US-003 ThreadStaleBanner',()=>{
 test('AC-9 displays stale banner and title',()=>{const app=mount(); expect(app.one('[data-testid="thread-stale-banner"]')).toBeDefined(); expect(app.text()).toContain('fleet.threads.handoff.stale.title'); app.unmount()})
 test('AC-10 disables Discard while a thread job is active',()=>{const app=mount({id:'j',state:'RUNNING'}); expect(app.one('[data-testid="thread-stale-discard"]')?.props.disabled).toBe(true); app.unmount()})
 test('AC-11 confirms discard exactly once when idle',async()=>{const app=mount(); click(app.one('[data-testid="thread-stale-discard"]')); await settle(); click(app.one('[data-testid="thread-discard-confirm"]')); expect(app.emitted('discard')).toEqual([[]]); app.unmount()})
})

describe('US-007 ThreadStaleBanner with kodaToolsUnavailableOn absent',()=>{
 test('AC-6 renders stale banner when session is stale and kodaToolsUnavailableOn is absent',()=>{const activeJob=null;const app=mount(activeJob); expect(app.one('[data-testid="thread-stale-banner"]')).toBeDefined(); expect(app.text()).toContain('fleet.threads.handoff.stale.title'); app.unmount()})
})
