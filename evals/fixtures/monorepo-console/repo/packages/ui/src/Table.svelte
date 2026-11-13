<script lang="ts">
	let { columns, rows } = $props();
</script>

<table>
	<thead>
		<tr>
			{#each columns as column (column)}
				<th>{column}</th>
			{/each}
		</tr>
	</thead>
	<tbody>
		{#each rows as row (row.id)}
			<tr>
				{#each columns as column (column)}
					<td>{row[column]}</td>
				{/each}
			</tr>
		{/each}
	</tbody>
</table>

<style>
	table {
		width: 100%;
		border-collapse: collapse;
		background: var(--color-surface);
	}

	th,
	td {
		padding: 8px;
		text-align: left;
		border-bottom: 1px solid var(--color-hairline);
	}

	th {
		color: var(--color-muted);
		font-weight: 500;
	}
</style>
