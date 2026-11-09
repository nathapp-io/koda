import type { FlowStartFormValues } from '~/lib/fleet-flow-start-form'

/** The API request body used to start a flow from a thread. */
export interface FlowStartBody {
  features: { feature: string; specPath: string; dependsOn: string[] }[]
  roles: { reviewer: string; supervisor: string }
  costCapUsd: number
}

/** Convert schema-parsed form values into a detached request body. */
export function toFlowStartBody(values: FlowStartFormValues): FlowStartBody {
  return {
    features: values.features.map(({ feature, specPath, dependsOn }) => ({
      feature,
      specPath,
      dependsOn: [...dependsOn],
    })),
    roles: { reviewer: values.roles.reviewer, supervisor: values.roles.supervisor },
    costCapUsd: Number(values.costCapUsd),
  }
}
