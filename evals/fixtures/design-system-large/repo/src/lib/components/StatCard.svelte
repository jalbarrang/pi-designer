<script lang="ts">
	let { label, value, delta } = $props();
</script>

<article class="stat">
	<p class="label">{label}</p>
	<p class="value">{value}</p>
	<p class="delta">{delta}</p>
</article>

<style>
	.stat {
		padding: 16px;
		background: var(--color-surface);
		border: 1px solid var(--color-hairline);
		border-radius: var(--radius-md);
	}

	.label {
		margin: 0;
		color: var(--color-muted);
		font-size: 0.8125rem;
	}

	.value {
		margin: 4px 0 0;
		font-family: var(--font-heading);
		font-size: 1.5rem;
	}

	.delta {
		margin: 4px 0 0;
		color: var(--color-primary);
		font-size: 0.8125rem;
	}
</style>
