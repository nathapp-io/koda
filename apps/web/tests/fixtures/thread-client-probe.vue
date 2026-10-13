<script setup lang="ts">
// US-003 AC06 fixture: mounts a component whose setup calls useThread the way the
// thread detail page will, so the test can observe the production openStream side
// effect (one EventSource on the thread events route) through mount-sfc.
import { useThread } from '~/composables/useThread'

useThread('web', 'th1')
</script>

<template>
  <div data-testid="thread-client-probe"></div>
</template>