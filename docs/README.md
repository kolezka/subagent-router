# Dokumentacja

Ten katalog zawiera dokumentację projektu `subagent-router`. Trwa implementacja pierwszego PoC. Pełne wsparcie natywnych klientów wymaga osobnych pomiarów.

## Aktualny stan

- Specyfikacja: [pełny draft routingu modeli subagentów](superpowers/specs/2026-09-06-subagent-model-routing-design.md), rewizja 5 z 2026-09-08. Zachowuje wymagania, decyzje D1-D11, pomiary M1-M10 i kontrakty katalogu, read-only ról oraz CLI. Doprecyzowuje granice router / KB / gateway / przyszły runtime, transparentny transport bez obowiązkowego AI SDK i bramki walidacji runtime adapterów. Rewizja 5 wskazuje zewnętrzną bramę, docelowo `9router` lub OmniRoute, jako właściciela rozmowy z dostawcą i zakazuje zależności od `@the-next-ai/ai-gateway`. Nie opisuje zaimplementowanego runtime ani ponownie wykonanych pomiarów.
- Plan implementacji: [plan TDD routingu modeli subagentów](superpowers/plans/2026-09-06-subagent-model-routing.md), rewizja 3 z 2026-09-08, nadal draft do przeglądu. Zachowuje identyfikatory i zależności piętnastu zadań z cyklem RED/GREEN/REFACTOR oraz metodę `superpowers:subagent-driven-development`. Rozdziela zakresy modułów i mapuje doprecyzowane wymagania na sekcje specu, zadania i testy. Wykonanie trwa. Pierwszym celem jest pion HTTP dla Claude Code; pozostałe zadania pozostają w planie.
- Kod rdzenia, atomowego store, adaptera markerów i handlera HTTP istnieje. Wyniki lokalne nie są dowodem wsparcia realnego klienta.
- [Instrukcja PoC](poc.md): lokalne demo i konfiguracja zewnętrznej bramy.
- CLI (`src/cli/*`, `src/agents/export.ts`) is implemented locally: read-only inspection plus
  writes (`models sync`, `models describe`, `config export`, `doctor --connect`, `serve`). See
  [cli/README.md](cli/README.md). Native client integration remains unmeasured; see
  [cli/GAPS.md](cli/GAPS.md).

## Mapa dokumentacji

- [CONVENTIONS.md](CONVENTIONS.md): zasady statusów, dowodów i linkowania.
- [gateways/cliproxyapi.md](gateways/cliproxyapi.md): kontrakt HTTP CLIProxyAPI i testy loopback; natywne wsparcie klienta nadal pending.
- [cli/](cli/README.md): documentation block (README, CONTRACTS, INVARIANTS, GAPS, OPERATIONS) for
  `src/cli/*` and `src/agents/export.ts`.
- [core/](core/README.md), [catalog/](catalog/README.md), [agents/](agents/README.md),
  [transport/](transport/README.md): the same five-file documentation block for those source
  directories, from a separate integration slice.
- Every block above carries `verified_against` with the commit its claims were checked against
  (file by file, test by test); a later commit is not covered until the stamp is refreshed.
- [measurements/claude-code-2.1.263-partial.md](measurements/claude-code-2.1.263-partial.md):
  przegląd historycznych artefaktów parent/child dla Claude Code 2.1.263. To jest przegląd
  zapisanych danych, nie nowy pomiar natywny ani promocja wsparcia; M1, M3/M3-B2, M4, M10 i
  freshness pozostają niepotwierdzone.
- `superpowers/specs/`: specyfikacje decyzji i wymaganych zachowań.
- `superpowers/plans/`: istniejący plan wykonania, nadal draft. Jego edycja nie uruchamia zadań ani nie zatwierdza wdrożenia.

## Docelowe bloki po wdrożeniu

Dopiero gdy powstanie działający, zweryfikowany blok, jego dokumentacja będzie zawierać pięć plików: `README`, `CONTRACTS`, `INVARIANTS`, `GAPS` i `OPERATIONS`. W razie potrzeb może dojść `DECISIONS`. `cli/`, `core/`, `catalog/`, `agents/` i `transport/` (opisane powyżej) są takimi blokami; każdy ma `verified_against` ze sprawdzonym commitem.

Te bloki nie są tworzone dla samego draftu. Nie zastępują ich spekulatywne opisy ani deklaracje weryfikacji nieistniejącego kodu.
