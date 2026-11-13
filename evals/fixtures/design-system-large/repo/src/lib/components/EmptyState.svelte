<script lang="ts">
	let { title, body } = $props();
</script>

<div class="empty">
	<p class="title">{title}</p>
	<p class="body">{body}</p>
</div>

<style>
	.empty {
		padding: 32px;
		text-align: center;
		background: var(--color-surface);
		border: 1px dashed var(--color-hairline);
		border-radius: var(--radius-md);
	}

	.title {
		margin: 0 0 4px;
		font-family: var(--font-heading);
		font-size: 1.125rem;
	}

	.body {
		margin: 0;
		color: var(--color-muted);
	}
</style>
