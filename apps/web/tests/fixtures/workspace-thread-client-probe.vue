<script setup lang="ts">
// US-004 AC-8 fixture: mounts a component whose setup calls useWorkspaceThread the way the
// workspace thread detail page will, so the test can observe the production openStream side
// effect (one EventSource on /api/threads/<id>/events) through mount-sfc.
//
// US-002: it also renders what the page renders from the same controller state — one node per
// message (its status as an attribute) and the composer element the page's
// `FleetThreadsThreadComposer` receives (`canSend` bound to `disabled`, the creator's view) — so a
// spec can see the transcript and the composer heal without mounting the whole page.
import { useWorkspaceThread } from '~/composables/useWorkspaceThread'
import { composerState } from '~/lib/thread-view'

const controller = useWorkspaceThread('t1')
</script>

<template>
  <div data-testid="workspace-thread-client-probe">
    <p
      v-for="message in controller.messages.value"
      :key="message.id"
      :data-message="message.id"
      :data-status="message.status"
    >
      {{ message.content }}
    </p>
    <input
      v-if="controller.thread.value"
      data-testid="composer"
      :disabled="!composerState(controller.thread.value, controller.messages.value, { isCreator: true }).canSend"
    >
  </div>
</template>
