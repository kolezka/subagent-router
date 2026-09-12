# Subagent Router Code Graph

Source revision: `4ca2e7a73beaf7baf43de937fc3e43a761dd9d63`.

This graph was rebuilt from a fresh archive of 127 committed code files under `src`, `scripts` and `tests`. It contains 1065 nodes, 3030 simple undirected edges and 55 communities. Only `.ts`, `.js`, `.mjs` and `.cjs` inputs were included. Docs, JSON configuration, local settings, credentials, native captures, build output and caches were excluded. Community labels are selected deterministically from the dominant source file, without an LLM.

## Use and limits

- Open [graph.html](graph.html), read [GRAPH_REPORT.md](GRAPH_REPORT.md), or query [graph.json](graph.json).
- [manifest.json](manifest.json) records the selected source paths, sizes, SHA256 and Git blob hashes. Each source byte sequence was compared with the named Git revision.
- This is a structural navigation aid, not an exhaustive call-site audit or evidence of client/runtime support. Missing graph relationships do not prove an absence in code.
- The CLI extraction emitted 3303 relation records before clustering produced the 3030-edge simple graph. Parallel and reverse relations can be simplified by that representation; do not use edge counts as a census of runtime calls.
- Built-in modules and generated `tests/dist` imports are reference-only nodes, not files parsed from the archive: `node:fs`, `node:fs/promises`, `node:os`, `tests/dist/cli.js`, `tests/dist/core.js`, `tests/dist/handler.js`.
- A separate raw AST diagnostic exposed unresolved edges before graph normalization. The published graph itself was checked for unique nodes and valid edge endpoints. Those structural checks do not prove completeness.
- The report's token counts cover semantic extraction: zero input and zero output tokens. Agent/tool orchestration cost is not included in those figures.
- Opening the HTML loads its pinned visualization library from a CDN. Extraction and deterministic labeling made no provider or native-client calls.

## Regeneration

1. Select a committed source revision and export only the code paths above with `git archive` into a fresh directory.
2. Run `graphify extract <staging-tree> --code-only --no-gitignore --no-cluster --max-workers 2`. The ignore override is only for this selected committed-file archive, never an active checkout.
3. Run `graphify cluster-only <staging-tree> --no-label` and label communities from their dominant source file.
4. Stamp `built_at_commit`, classify unresolved generated/built-in references, and verify source bytes and manifest hashes against Git.
5. Export HTML from that finalized graph and publish only these five artifacts. Keep caches and temporary outputs local.

The earlier mixed graph remains in commit `1f20dc49050ee371c3a0ed57b1b9da8a40773982`. It is historical, not this graph's source.
