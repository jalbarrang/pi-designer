<script lang="ts">
	let { children } = $props();
</script>

<div class="bar">
	{@render children()}
</div>

<style>
	.bar {
		display: flex;
		gap: 8px;
		align-items: center;
		padding: 8px 0;
		border-bottom: 1px solid var(--color-hairline);
	}
</style>
