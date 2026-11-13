<script lang="ts">
	let { items } = $props();
</script>

<nav class="rail">
	{#each items as item (item.href)}
		<a {href} class:active={item.active}>{item.label}</a>
	{/each}
</nav>

<style>
	.rail {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 16px;
		border-right: 1px solid var(--color-hairline);
	}

	.active {
		color: var(--color-ink);
		font-weight: 600;
	}
</style>
