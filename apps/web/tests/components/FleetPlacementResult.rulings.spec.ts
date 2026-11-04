import { expect, test } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'

test('AC-14: queued FIX bot_rulings misfit is translated', () => {
  const app = mountSfc(webFile('components/fleet/FleetPlacementResult.vue'), {
    props: { slug: 'koda', result: { job: { id: 'fix1', state: 'QUEUED' }, placement: { assigned: false, runnerId: null, misfits: [{ runnerId: 'r1', name: 'Runner', reason: 'bot_rulings' }] } }, runnerName: () => null },
    components: uiStubs, globals: { useI18n: () => enI18n() },
  })
  expect(app.text()).toContain('This runner cannot apply PR rulings')
  expect(app.text()).not.toContain('bot_rulings')
  app.unmount()
})
