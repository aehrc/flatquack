---
name: benchmark
description: Use when the user asks to benchmark, measure performance of, or compare the speed of a ViewDefinition against the test datasets. Also use when asked to compare benchmark results across different regimes, views, or datasources.
---

# Benchmark

Run a ViewDefinition against `.local/ndjson` and/or `.local/parquet` test datasets, save results, and display a summary.

## Running a benchmark

```bash
bun run scripts/run-benchmark.js \
  --view <path-to-view.json> \
  --label <regime-name> \
  [--datasource ndjson|parquet|both]   # default: ndjson
  [--runs N]                            # default: 3
```

- `--label` identifies the testing regime (e.g. `baseline`, `after-repeat-impl`, `parquet-pruning`). Used as the filename prefix for saved results.
- Results are saved to `.local/benchmark_results/<label>__<timestamp>.json`.
- The script prints a summary table when it completes.

**Examples:**
```bash
# Quick ndjson-only baseline
bun run scripts/run-benchmark.js --view .local/foreach_view.json --label baseline

# Full comparison across both datasources
bun run scripts/run-benchmark.js --view .local/foreach_view.json --label baseline --datasource both

# Parquet only after an optimisation
bun run scripts/run-benchmark.js --view .local/foreach_view.json --label after-pruning --datasource parquet
```

## Comparing saved results

To summarise and compare all saved results (across regimes, views, and datasources):

```bash
bun run scripts/compare-benchmarks.js [--results-dir .local/benchmark_results]
```

This prints a table grouped by view + datasource, with one column per label so you can see the delta between regimes at a glance. If the compare script doesn't exist yet, create it — see the result file schema below.

## Result file schema

Each `.json` file in `.local/benchmark_results/` looks like:

```json
{
  "label": "baseline",
  "view": ".local/foreach_view.json",
  "datasource": "ndjson",
  "runs": 3,
  "timestamp": "2026-04-29T...",
  "results": [
    { "label": "ndjson", "min": 2692, "avg": 2716, "rowCount": 3255000, "runs": 3, "times": [...] }
  ]
}
```

## Summary table format

When displaying results (live or from saved files), use this layout:

| View | Dataset | min (ms) | avg (ms) | rows |
|------|---------|----------|----------|------|
| foreach_view | ndjson | 2,692 | 2,716 | 3,255,000 |
| foreach_view | parquet | 63,810 | 64,796 | 3,255,000 |

When comparing regimes, add a column per label and a Δ column showing the difference.
