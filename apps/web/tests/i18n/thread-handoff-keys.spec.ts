import { describe, expect, test } from '@jest/globals'
import en from '../../i18n/locales/en.json'
import zh from '../../i18n/locales/zh.json'
const expected=['nothingToPublish','turnRunning','handoffBusy','notPublished','sessionActive','notPlanned','planNotCompleted']
describe('US-003 handoff translations',()=>{test('AC-12 blocked keys are exact and non-empty in both locales',()=>{for(const locale of [en,zh]){const blocked=locale.fleet.threads.handoff.blocked; expect(Object.keys(blocked).sort()).toEqual([...expected].sort()); for(const value of Object.values(blocked)) expect(value.trim().length).toBeGreaterThan(0)}})})
