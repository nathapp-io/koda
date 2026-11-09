import * as z from 'zod'
import { FEATURE_RE } from '~/lib/fleet-dispatch'

export const FLOW_MAX_FEATURES = 20
export const FLOW_COST_CAP_MAX_USD = 1000
export const FLOW_ROLE_RE = /^[A-Za-z0-9._:/\x5b\x5d=,-]{1,200}$/
export const FLOW_SPEC_PATH_MAX = 300

type Translate = (key: string) => string

export interface FlowStartRow {
  feature: string
  specPath: string
  dependsOn: string[]
}

export interface FlowStartFormValues {
  features: FlowStartRow[]
  roles: { reviewer: string; supervisor: string }
  costCapUsd: number | string
}

const costCap = (message: string) => z.coerce.number({ invalid_type_error: message })
  .gt(0, message)
  .max(FLOW_COST_CAP_MAX_USD, message)
  .refine(value => Number.isFinite(value) && Math.round(value * 10_000) / 10_000 === value, message)

export function buildFlowStartSchema(t: Translate) {
  const validation = 'fleet.flows.start.validation.'
  const rowSchema = z.object({
    feature: z.string().trim().regex(FEATURE_RE, t(`${validation}feature`)).refine(value => !value.includes('..'), t(`${validation}feature`)),
    specPath: z.string().trim().min(1, t(`${validation}specPath`)).max(FLOW_SPEC_PATH_MAX, t(`${validation}specPath`))
      .refine(value => !value.includes('\0') && !value.startsWith('/') && value.endsWith('.md') && !value.split('/').includes('..'), t(`${validation}specPath`)),
    dependsOn: z.array(z.string()),
  })

  return z.object({
    features: z.array(rowSchema).min(1, t(`${validation}featuresCount`)).max(FLOW_MAX_FEATURES, t(`${validation}featuresCount`))
      .superRefine((features, ctx) => {
        const names = new Set<string>()
        for (let index = 0; index < features.length; index++) {
          const feature = features[index]!
          if (names.has(feature.feature)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'feature'], message: t(`${validation}featureDuplicate`) })
          }
          const earlierNames = new Set(features.slice(0, index).map(row => row.feature))
          const seenDependencies = new Set<string>()
          for (const dependency of feature.dependsOn) {
            if (!earlierNames.has(dependency) || seenDependencies.has(dependency)) {
              ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'dependsOn'], message: t(`${validation}dependsOn`) })
              break
            }
            seenDependencies.add(dependency)
          }
          names.add(feature.feature)
        }
      }),
    roles: z.object({
      reviewer: z.string().trim().regex(FLOW_ROLE_RE, t(`${validation}role`)),
      supervisor: z.string().trim().regex(FLOW_ROLE_RE, t(`${validation}role`)),
    }),
    costCapUsd: costCap(t(`${validation}costCap`)),
  })
}

export function buildPreApprovalSchema(t: Translate) {
  return z.object({ costCapUsd: costCap(t('fleet.flows.preapproval.validation')) })
}
