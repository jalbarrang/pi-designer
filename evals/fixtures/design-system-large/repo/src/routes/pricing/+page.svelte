<script lang="ts">
	import PlanCard from "$lib/components/PlanCard.svelte";

	const plans = [
		{ id: "starter", name: "Starter", price: "$0", blurb: "One workspace, 3 seats." },
		{ id: "team", name: "Team", price: "$48", blurb: "Unlimited workspaces, 25 seats.", featured: true },
		{ id: "scale", name: "Scale", price: "$180", blurb: "SSO, audit log, priority support." },
	];
</script>

<svelte:head>
	<title>Pricing · Northwind</title>
</svelte:head>

<header class="head">
	<h1>Pricing</h1>
	<p class="lede">Every plan includes the full analytics surface.</p>
</header>

<div class="grid">
	{#each plans as plan (plan.id)}
		<PlanCard {...plan} />
	{/each}
</div>

<style>
	.head {
		margin-bottom: 16px;
	}

	h1 {
		margin: 0 0 8px;
		font-family: var(--font-heading);
		font-size: 1.5rem;
		font-weight: 600;
	}

	.lede {
		margin: 0;
		color: var(--color-muted);
	}

	.grid {
		display: grid;
		gap: 16px;
		grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
	}
</style>
