<script lang="ts">
	import DataTable from "$lib/components/DataTable.svelte";
	import EmptyState from "$lib/components/EmptyState.svelte";

	const rows = [
		{ id: "r-1042", name: "Weekly digest", owner: "ops" },
		{ id: "r-1043", name: "Churn cohorts", owner: "growth" },
	];
</script>

<h1>Reports</h1>

{#if rows.length === 0}
	<EmptyState title="No reports yet" body="Create one from a saved query." />
{:else}
	<DataTable columns={["id", "name", "owner"]} {rows} />
{/if}

<style>
	h1 {
		margin: 0 0 16px;
		font-family: var(--font-heading);
		font-size: 1.5rem;
	}
</style>
