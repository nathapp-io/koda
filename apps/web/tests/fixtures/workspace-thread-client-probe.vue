<script setup lang="ts">
// US-004 AC-8 fixture: mounts a component whose setup calls useWorkspaceThread the way the
// workspace thread detail page will, so the test can observe the production openStream side
// effect (one EventSource on /api/threads/<id>/events) through mount-sfc.
import { useWorkspaceThread } from '~/composables/useWorkspaceThread'

useWorkspaceThread('t1')
</script>

<template>
  <div data-testid="workspace-thread-client-probe"></div>
</template>
