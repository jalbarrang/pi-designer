<script lang="ts">
	let { name, price, blurb } = $props();
</script>

<article class="card">
	<h2>{name}</h2>
	<p class="price">{price}</p>
	<p class="blurb">{blurb}</p>
</article>

<style>
	.card {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 20px;
		background: var(--color-surface);
		border: 1px solid var(--color-hairline);
		border-radius: var(--radius-md);
	}

	h2 {
		margin: 0;
		font-family: var(--font-heading);
		font-size: 1.125rem;
		font-weight: 600;
	}

	.price {
		margin: 0;
		font-family: var(--font-heading);
		font-size: 1.375rem;
	}

	.blurb {
		margin: 0;
		color: var(--color-muted);
	}
</style>
