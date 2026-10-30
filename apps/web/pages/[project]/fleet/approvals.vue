<script setup lang="ts">
// US-010: the project's fleet inbox was retired in favour of the approval engine's project inbox at
// /<slug>/approvals. Links written against the old path still carry the query (`?id=` opens one request), so the
// redirect keeps it and answers 302: a cached 301 would outlive the links 7c retires.
definePageMeta({ layout: 'default' })
const route = useRoute()
navigateTo({ path: `/${String(route.params.project)}/approvals`, query: route.query }, { redirectCode: 302 })
</script>
