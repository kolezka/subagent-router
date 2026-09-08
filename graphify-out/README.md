# Subagent Router Code Graph

Source revision: `008ed4b05b8b28e89bfbd67d76d1ceaf220c9db0`.

This is a code-only snapshot built from a fresh Git archive, not from a developer's working directory. It contains 779 nodes and 2,190 edges from 113 AST-supported files, including tests and JSON configuration fixtures. Semantic Markdown documentation and unsupported file formats were not indexed. Community names come from their dominant source file, without an LLM.

## Use and limits

- Open [graph.html](graph.html) for the interactive view, or read [GRAPH_REPORT.md](GRAPH_REPORT.md).
- [graph.json](graph.json) holds the graph and its source revision. [manifest.json](manifest.json) lists the indexed input files.
- This is a navigation aid, not an exhaustive call-site audit or proof of native-client compatibility. Missing nodes or edges do not prove that behavior is absent.
- The extractor inferred `tests/dist/cli.js`, `tests/dist/core.js` and `tests/dist/handler.js` from generated-script imports in tests. They are marked as ambiguous reference-only nodes with `referenced_file`, not as parsed source files. `node:fs/promises` is an external module reference.
- The report's confidence and cycle results describe the extracted graph, not every possible runtime path. Local AST inference can produce inferred edges even though no LLM was used.
- Opening the HTML loads the pinned vis-network library from a CDN. Extraction and labeling used no provider calls or native-client processes.

The earlier mixed code/design graph remains available in commit `1f20dc49050ee371c3a0ed57b1b9da8a40773982`. Its semantic summaries and caches are not part of this current snapshot.

## Regeneration

1. Choose a committed source revision and create a fresh staging tree with `git archive`. Do not copy an active checkout or reuse a graph output directory containing old semantic data.
2. Run `graphify extract <staging-tree> --code-only --no-gitignore --no-dedup --max-workers 2`. The ignore override is for this committed-file archive only, never an active checkout.
3. Run `graphify cluster-only <staging-tree> --no-label`. Name communities deterministically from source-file membership rather than enabling provider-backed labeling.
4. Keep `built_at_commit` tied to the archived revision. Classify unresolved generated-module targets as references rather than inventing manifest entries for them.
5. Verify unique node IDs, valid edge endpoints, source/manifest agreement, and input blob hashes against the selected Git tree. Keep source paths relative and exclude local configuration and capture data.
6. Publish only the graph, HTML, report, manifest and this scope note. Do not commit caches, local tool paths or raw probe captures.

Changing extraction tools can change the graph even for the same source revision. Recheck the generated counts and provenance rather than copying this snapshot's numbers into a new report.
