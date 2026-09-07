# Dokumentacja

Ten katalog zawiera dokumentację projektu `subagent-router`. Projekt jest na etapie specyfikacji, bez implementacji.

## Aktualny stan

- Specyfikacja: [pełny draft routingu modeli subagentów](superpowers/specs/2026-09-06-subagent-model-routing-design.md), rewizja 5 z 2026-09-08. Zachowuje wymagania, decyzje D1-D11, pomiary M1-M10 i kontrakty katalogu, read-only ról oraz CLI. Doprecyzowuje granice router / KB / gateway / przyszły runtime, transparentny transport bez obowiązkowego AI SDK i bramki walidacji runtime adapterów. Rewizja 5 wskazuje zewnętrzną bramę, docelowo `9router` lub OmniRoute, jako właściciela rozmowy z dostawcą i zakazuje zależności od `@the-next-ai/ai-gateway`. Nie opisuje zaimplementowanego runtime ani ponownie wykonanych pomiarów.
- Plan implementacji: [plan TDD routingu modeli subagentów](superpowers/plans/2026-09-06-subagent-model-routing.md), rewizja 3 z 2026-09-08, nadal draft do przeglądu. Zachowuje identyfikatory i zależności piętnastu zadań z cyklem RED/GREEN/REFACTOR oraz metodę `superpowers:subagent-driven-development`. Rozdziela zakresy modułów i mapuje doprecyzowane wymagania na sekcje specu, zadania i testy. Wykonanie nie rozpoczęte.
- Kod, testy integracyjne i dokumentacja działających bloków: jeszcze nie istnieją.

## Mapa dokumentacji

- [CONVENTIONS.md](CONVENTIONS.md): zasady statusów, dowodów i linkowania.
- `superpowers/specs/`: specyfikacje decyzji i wymaganych zachowań.
- `superpowers/plans/`: istniejący plan wykonania, nadal draft. Jego edycja nie uruchamia zadań ani nie zatwierdza wdrożenia.

## Docelowe bloki po wdrożeniu

Dopiero gdy powstanie działający, zweryfikowany blok, jego dokumentacja będzie zawierać pięć plików: `README`, `CONTRACTS`, `INVARIANTS`, `GAPS` i `OPERATIONS`. W razie potrzeb może dojść `DECISIONS`.

Te bloki nie są tworzone dla samego draftu. Nie zastępują ich spekulatywne opisy ani deklaracje weryfikacji nieistniejącego kodu.
