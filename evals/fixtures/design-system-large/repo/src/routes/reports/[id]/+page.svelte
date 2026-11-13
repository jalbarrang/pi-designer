<script lang="ts">
	import Badge from "$lib/components/Badge.svelte";

	let { data } = $props();
</script>

<h1>{data.report.name}</h1>
<p class="meta">Owner <Badge>{data.report.owner}</Badge></p>

<style>
	h1 {
		margin: 0 0 8px;
		font-family: var(--font-heading);
		font-size: 1.5rem;
	}

	.meta {
		display: flex;
		gap: 8px;
		align-items: center;
		margin: 0 0 16px;
		color: var(--color-muted);
	}
</style>
