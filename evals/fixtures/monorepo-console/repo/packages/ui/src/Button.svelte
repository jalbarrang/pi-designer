<script lang="ts">
	let { children, variant = "primary" } = $props();
</script>

<button class:secondary={variant === "secondary"}>{@render children()}</button>

<style>
	button {
		padding: 8px 16px;
		font: inherit;
		color: var(--color-surface);
		background: var(--color-primary);
		border: 1px solid var(--color-primary);
		border-radius: var(--radius-sm);
		cursor: pointer;
	}

	.secondary {
		color: var(--color-primary);
		background: transparent;
	}
</style>
