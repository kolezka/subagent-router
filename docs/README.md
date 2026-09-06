# Dokumentacja

Ten katalog zawiera dokumentację projektu `subagent-router`. Projekt jest na etapie specyfikacji, bez implementacji.

## Aktualny stan

- Specyfikacja: [draft routingu modeli subagentów](superpowers/specs/2026-09-06-subagent-model-routing-design.md), rewizja 3. Zachowuje pomiary rewizji 2 i dodaje projektowany kontrakt read-only discovery ról, katalogu modeli, CLI oraz route preview. Nie opisuje zaimplementowanego runtime.
- Plan implementacji: [plan TDD routingu modeli subagentów](superpowers/plans/2026-09-06-subagent-model-routing.md), draft do przeglądu. Piętnaście zadań z cyklem RED/GREEN/REFACTOR, wykonywanych przez `superpowers:subagent-driven-development`. Wykonanie nie rozpoczęte.
- Kod, testy integracyjne i dokumentacja działających bloków: jeszcze nie istnieją.

## Mapa dokumentacji

- [CONVENTIONS.md](CONVENTIONS.md): zasady statusów, dowodów i linkowania.
- `superpowers/specs/`: specyfikacje decyzji i wymaganych zachowań.
- `superpowers/plans/`: przyszłe plany wykonania zatwierdzonych specyfikacji. Katalog powstanie dopiero razem z pierwszym planem.

## Docelowe bloki po wdrożeniu

Dopiero gdy powstanie działający, zweryfikowany blok, jego dokumentacja będzie zawierać pięć plików: `README`, `CONTRACTS`, `INVARIANTS`, `GAPS` i `OPERATIONS`. W razie potrzeb może dojść `DECISIONS`.

Te bloki nie są tworzone dla samego draftu. Nie zastępują ich spekulatywne opisy ani deklaracje weryfikacji nieistniejącego kodu.
