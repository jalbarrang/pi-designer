<script lang="ts">
	let { children } = $props();
</script>

<span class="badge">{@render children()}</span>

<style>
	.badge {
		display: inline-flex;
		padding: 2px 8px;
		font-size: 0.75rem;
		color: var(--color-primary);
		background: color-mix(in oklab, var(--color-primary) 12%, transparent);
		border-radius: var(--radius-sm);
	}
</style>
