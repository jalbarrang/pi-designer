<script lang="ts">
	import "../app.css";
	let { children } = $props();
</script>

<div class="shell">
	<nav class="rail">
		<a href="/pricing">Pricing</a>
		<a href="/usage">Usage</a>
	</nav>
	<main>{@render children()}</main>
</div>

<style>
	.shell {
		display: grid;
		grid-template-columns: 220px 1fr;
		min-height: 100vh;
	}

	.rail {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 16px;
		border-right: 1px solid var(--color-hairline);
	}

	main {
		padding: 24px;
	}
</style>
