<script lang="ts">
	import StatCard from "$lib/components/StatCard.svelte";
	import Sparkline from "$lib/components/Sparkline.svelte";

	const series = [12, 18, 15, 24, 31, 28, 36];
</script>

<h1>Usage</h1>

<div class="row">
	<StatCard label="Requests" value="182k" delta="+12%" />
	<StatCard label="p95" value="240ms" delta="-8%" />
	<StatCard label="Errors" value="0.4%" delta="+0.1%" />
</div>

<Sparkline {series} label="Requests per day" />

<style>
	h1 {
		margin: 0 0 16px;
		font-family: var(--font-heading);
		font-size: 1.5rem;
	}

	.row {
		display: grid;
		gap: 16px;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		margin-bottom: 16px;
	}
</style>
