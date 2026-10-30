<script setup lang="ts">
// US-010: the fleet inbox was retired in favour of the approval engine's inbox at /approvals. Fleet notifications
// still link here until 7c, so this page redirects rather than 404s — keeping the query (`?id=` opens one request)
// and answering 302, because a cached 301 would outlive that link.
definePageMeta({ layout: 'default' })
const route = useRoute()
navigateTo({ path: '/approvals', query: route.query }, { redirectCode: 302 })
</script>
