import { expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { ref } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
const items=[{category:'ASSIGNED',inApp:true,email:true}]
test('AC-3/4/5: notification settings render enlarged checkboxes within labeled touch targets', async () => {
 const fake={view:ref({emailAvailable:true,emailEnabled:true,items:[] as typeof items}),pending:ref(false),load:jest.fn(async()=>{fake.view.value.items=items}),setInApp:jest.fn(),setEmail:jest.fn(),setEmailEnabled:jest.fn()}
 const app=mountSfc(webFile('pages','settings','notifications.vue'),{components:uiStubs,alias:{'~/composables/useNotificationPreferences':{useNotificationPreferences:()=>fake}},globals:{useI18n:()=>enI18n(),useAppToast:()=>({error:jest.fn(),success:jest.fn()}),definePageMeta:()=>undefined}})
 for(let i=0;i<6;i++){await new Promise(r=>setImmediate(r));await Vue.nextTick()}
 for(const id of ['notification-email-master','notification-pref-ASSIGNED','notification-pref-email-ASSIGNED']) { const node=app.find(`[data-testid="${id}"]`)[0]; expect(node.props.class).toContain('h-5'); expect(node.props.class).toContain('w-5') }
 for(const [id,required] of [['notification-pref-ASSIGNED',['min-h-11','sm:min-h-0']],['notification-pref-email-ASSIGNED',['min-h-11']]] as const) { const node=app.find(`[data-testid="${id}"]`)[0]; const parent=node.parent; expect(parent.tag).toBe('label'); expect(parent.props.for).toBe(id); for(const token of required) expect(parent.props.class).toContain(token) }
 expect(app.find('[data-testid="notification-pref-email-ASSIGNED"]')[0].props['aria-label']).toBeTruthy()
 app.unmount()
})
