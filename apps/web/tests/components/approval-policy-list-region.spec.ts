import { describe, expect, it } from '@jest/globals'
import { defineComponent, h } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n } from '../helpers/fleet-harness'

const seen: Array<{ regionLabel?: string; testid?: string }> = []
const Table = defineComponent({
  name: 'Table',
  props: ['regionLabel'],
  setup(props, { attrs, slots }) {
    seen.push({ regionLabel: props.regionLabel as string | undefined, testid: attrs['data-testid'] as string | undefined })
    return () => h('div', attrs, slots.default?.())
  },
})

 describe('ApprovalPolicyList named scroll region (US-008)', () => {
  it("AC-9: opts the policy list into the localized 'Approval policies' region", () => {
    seen.length = 0
    const app = mountSfc(webFile('components', 'approvals', 'ApprovalPolicyList.vue'), {
      props: {
        base: { kind: 'global' },
        policies: [{
          id: 'p1', selector: '*|fleet.runner.update|all', projectId: null,
          permissionPattern: 'fleet.runner.update', principalType: null, roleId: null, principalId: null,
          mode: 'human', timeoutSec: null, onTimeout: 'reject', requiredApprovals: 1,
          approverMustHoldAction: true, requireDistinctApprover: false, updatedByType: 'USER',
          updatedById: 'u1', createdAt: '', updatedAt: '',
        }],
      },
      components: { Table },
      alias: { '~/components/ui/table': { Table, TableHeader: 'table-header', TableRow: 'table-row', TableHead: 'table-head', TableBody: 'table-body', TableCell: 'table-cell' } },
      globals: { useI18n: () => enI18n() },
    })
    expect(seen).toContainEqual({ regionLabel: 'Approval policies', testid: 'policy-list' })
    app.unmount()
  })
})
