# subagent-router

`subagent-router` to projekt małego, niezależnego pakietu do jawnego routingu modeli dla natywnych subagentów Claude Code, OpenCode i Codex.

Status: dostępny jest lokalny PoC warstwy HTTP oraz lokalny CLI (patrz sekcja "CLI (local)" poniżej). Wsparcie natywnych klientów wymaga jeszcze pomiarów. Rozmowę z dostawcą prowadzi zewnętrzna brama, np. 9router lub OmniRoute, bez zależności od `@the-next-ai/ai-gateway`.

- [Indeks dokumentacji](docs/README.md)
- [Draft specyfikacji routingu modeli](docs/superpowers/specs/2026-09-06-subagent-model-routing-design.md)

## Uruchomienie PoC

```sh
bun install --frozen-lockfile
bun run poc:demo
```

[Instrukcja i ograniczenia PoC](docs/poc.md). Demo używa lokalnej bramy testowej i syntetycznego profilu klienta.

## CLI (local)

The package also ships a local CLI (`src/cli/*`, built as `dist/cli.js`): read-only inspection
(`models list/show`, `agents list/show`, `route preview`, `config show/check`) plus writes
(`models sync`, `models describe`, `config export`, `doctor --connect`, `serve`). Everything is
local and offline except `models sync` and `doctor --connect`.

See [docs/cli/README.md](docs/cli/README.md) for the command index, [docs/cli/CONTRACTS.md](docs/cli/CONTRACTS.md)
and [docs/cli/INVARIANTS.md](docs/cli/INVARIANTS.md) for exact behavior, and
[docs/cli/OPERATIONS.md](docs/cli/OPERATIONS.md) for runnable examples. Native client integration
(Claude Code, OpenCode, or Codex actually loading an exported config) is still unmeasured; see
[docs/cli/GAPS.md](docs/cli/GAPS.md).
