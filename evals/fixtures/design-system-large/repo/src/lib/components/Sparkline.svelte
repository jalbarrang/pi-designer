<script lang="ts">
	let { series, label } = $props();
	const max = Math.max(...series);
	const points = series
		.map((value, index) => `${index * 12},${40 - (value / max) * 32}`)
		.join(" ");
</script>

<figure>
	<svg viewBox="0 0 84 40" role="img" aria-label={label}>
		<polyline {points} fill="none" stroke="var(--color-primary)" stroke-width="2" />
	</svg>
	<figcaption>{label}</figcaption>
</figure>

<style>
	figure {
		margin: 0;
	}

	svg {
		width: 100%;
		height: 64px;
	}

	figcaption {
		color: var(--color-muted);
		font-size: 0.8125rem;
	}
</style>
