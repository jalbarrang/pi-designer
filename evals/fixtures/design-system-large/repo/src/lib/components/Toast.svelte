<script lang="ts">
	let { message } = $props();
</script>

<p class="toast" role="status">{message}</p>

<style>
	.toast {
		margin: 0;
		padding: 8px 12px;
		background: var(--color-ink);
		color: var(--color-surface);
		border-radius: var(--radius-sm);
	}
</style>
