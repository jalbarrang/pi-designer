<script lang="ts">
	import Button from "../../../../packages/ui/src/Button.svelte";
</script>

<section class="hero">
	<h1>Operations, without the noise.</h1>
	<p>Northwind turns raw events into decisions your team can act on.</p>
	<Button>Start free</Button>
</section>

<style>
	.hero {
		max-width: 640px;
		margin: 96px auto;
		padding: 0 24px;
		text-align: center;
	}

	h1 {
		margin: 0 0 16px;
		font-family: var(--font-heading);
		font-size: 2.5rem;
		line-height: 1.1;
	}

	p {
		margin: 0 0 32px;
		color: var(--color-muted);
		font-size: 1.125rem;
	}
</style>
