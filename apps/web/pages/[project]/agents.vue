<script setup lang="ts">
import { toast } from 'vue-sonner'

interface Agent {
  id: string
  name: string
  slug: string
  roles: string[]
  capabilities: string[]
  status: 'ACTIVE' | 'PAUSED' | 'OFFLINE'
}

const route = useRoute()
const slug = route.params.project as string
const { $api } = useApi()

const { data: agentsData, refresh } = useAsyncData(
  `agents-${slug}`,
  () => $api.get('/agents') as Promise<Agent[]>,
)

const agents = computed(() => agentsData.value ?? [])

function statusClass(status: string) {
  if (status === 'ACTIVE') return 'bg-green-100 text-green-800'
  if (status === 'PAUSED') return 'bg-yellow-100 text-yellow-800'
  return ''
}

async function changeStatus(agent: Agent, newStatus: 'ACTIVE' | 'PAUSED' | 'OFFLINE') {
  try {
    await $api.patch(`/agents/${agent.id}`, { status: newStatus })
    toast.success(`Agent status updated to ${newStatus}`)
    refresh()
  } catch (err) {
    toast.error('Failed to update agent status')
  }
}
</script>

<template>
  <div class="space-y-4">
    <h1 class="text-2xl font-bold">Agents</h1>

    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Slug</TableHead>
          <TableHead>Roles</TableHead>
          <TableHead>Capabilities</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow v-for="agent in agents" :key="agent.id">
          <TableCell>{{ agent.name }}</TableCell>
          <TableCell>{{ agent.slug }}</TableCell>
          <TableCell>
            <div class="flex flex-wrap gap-1">
              <Badge
                v-for="role in agent.roles"
                :key="role"
                variant="outline"
                class="text-xs"
              >
                {{ role }}
              </Badge>
            </div>
          </TableCell>
          <TableCell>
            <div class="flex flex-wrap gap-1">
              <Badge
                v-for="cap in agent.capabilities"
                :key="cap"
                variant="outline"
                class="text-xs"
              >
                {{ cap }}
              </Badge>
            </div>
          </TableCell>
          <TableCell>
            <Badge
              :variant="agent.status === 'OFFLINE' ? 'secondary' : 'outline'"
              :class="statusClass(agent.status)"
            >
              {{ agent.status }}
            </Badge>
          </TableCell>
          <TableCell>
            <DropdownMenu>
              <DropdownMenuTrigger as-child>
                <Button variant="ghost" size="sm">Change Status</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem @click="changeStatus(agent, 'ACTIVE')">
                  ACTIVE
                </DropdownMenuItem>
                <DropdownMenuItem @click="changeStatus(agent, 'PAUSED')">
                  PAUSED
                </DropdownMenuItem>
                <DropdownMenuItem @click="changeStatus(agent, 'OFFLINE')">
                  OFFLINE
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  </div>
</template>
