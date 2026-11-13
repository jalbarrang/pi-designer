<script lang="ts">
	import PlanCard from "$lib/components/PlanCard.svelte";

	const plans = [
		{ id: "starter", name: "Starter", price: "$0", blurb: "One workspace, 3 seats." },
		{ id: "team", name: "Team", price: "$48", blurb: "Unlimited workspaces, 25 seats.", featured: true },
	];
</script>

<h1>Pricing</h1>

<div class="grid">
	{#each plans as plan (plan.id)}
		<PlanCard {...plan} />
	{/each}
</div>

<style>
	h1 {
		margin: 0 0 16px;
		font-family: var(--font-heading);
		font-size: 1.5rem;
		font-weight: 600;
	}

	.grid {
		display: grid;
		gap: 16px;
		grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
	}
</style>
