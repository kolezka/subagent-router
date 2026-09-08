# subagent-router

`subagent-router` to projekt małego, niezależnego pakietu do jawnego routingu modeli dla natywnych subagentów Claude Code, OpenCode i Codex.

Status: dostępny jest lokalny PoC warstwy HTTP. Wsparcie natywnych klientów wymaga jeszcze pomiarów. Rozmowę z dostawcą prowadzi zewnętrzna brama, np. 9router lub OmniRoute, bez zależności od `@the-next-ai/ai-gateway`.

- [Indeks dokumentacji](docs/README.md)
- [Draft specyfikacji routingu modeli](docs/superpowers/specs/2026-09-06-subagent-model-routing-design.md)

## Uruchomienie PoC

```sh
bun install --frozen-lockfile
bun run poc:demo
```

[Instrukcja i ograniczenia PoC](docs/poc.md). Demo używa lokalnej bramy testowej i syntetycznego profilu klienta.
