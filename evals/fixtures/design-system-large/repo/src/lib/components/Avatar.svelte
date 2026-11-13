<script lang="ts">
	let { name, src } = $props();
	const initials = name
		.split(" ")
		.map((part) => part[0])
		.join("")
		.slice(0, 2);
</script>

{#if src}
	<img src={src} alt={name} />
{:else}
	<span class="initials" aria-hidden="true">{initials}</span>
{/if}

<style>
	img,
	.initials {
		width: 32px;
		height: 32px;
		border-radius: 999px;
	}

	.initials {
		display: grid;
		place-items: center;
		font-size: 0.75rem;
		color: var(--color-surface);
		background: var(--color-primary);
	}
</style>
