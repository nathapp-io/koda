import { expect, jest, test } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, toastRecorder, uiStubs } from '../helpers/fleet-harness'
import type { FleetFlowDto, FleetFlowPage } from '~/lib/fleet-flows'
const flow: FleetFlowDto={id:'f1',projectId:'p1',repoId:'r1',threadId:null,entry:'THREAD',createdBy:{type:'USER',id:'u1'},branch:'main',specSha:'s',pinnedRunnerId:null,roles:{reviewer:'r',supervisor:'s'},costCapUsd:'9.0000',spentUsd:'1.0000',state:'RUNNING',approval:null,stopReason:null,stopDetail:null,endedAt:null,createdAt:'2026-01-01T00:00:00Z',features:[],url:''}
test('AC-6: flow state route has a responsive hit target', async()=>{
 const result:FleetFlowPage={records:[flow],total:1,current:1,size:20,hasNext:false,hasPrev:false}; const list=jest.fn(async()=>result); const toast=toastRecorder()
 const app=mountSfc(webFile('pages','[project]','flows','index.vue'),{globals:{useRoute:()=>({params:{project:'web'}}),useI18n:()=>enI18n(),useAppToast:()=>toast,useFleetFlows:()=>({list}),formatUsd:(v:string)=>v,useLocalePath:(p:string)=>p},alias:{'~/composables/useFleetFlows':{useFleetFlows:()=>({list})}},components:{...uiStubs,NuxtLink:{props:['to'],template:'<a :href="to"><slot /></a>'}}})
 await new Promise(r=>setImmediate(r)); await new Promise(r=>setImmediate(r))
 const a=app.find('a')[0]; expect(a.props.href).toBe('/web/flows/f1'); for(const token of ['inline-flex','min-h-11','items-center','sm:min-h-0']) expect(a.props.class).toContain(token); app.unmount()
})
