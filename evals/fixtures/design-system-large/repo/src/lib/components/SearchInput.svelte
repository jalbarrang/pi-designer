<script lang="ts">
	let { value = $bindable(""), placeholder = "Search" } = $props();
</script>

<input type="search" bind:value {placeholder} />

<style>
	input {
		width: 100%;
		padding: 8px 12px;
		font: inherit;
		color: var(--color-ink);
		background: var(--color-surface);
		border: 1px solid var(--color-hairline);
		border-radius: var(--radius-sm);
	}
</style>
