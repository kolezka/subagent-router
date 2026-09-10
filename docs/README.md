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
- Pierwszy realny pomiar `M3-A` (2026-09-10, realny klient `claude` 2.1.267, przebieg
  `tests/probes/.runs/handler-yYv981`, osądzony przez `tests/probes/judge-run.ts`): `judgeM3A`
  zwrócił `passed` dla obu przechwyconych par kanału A. Zadeklarowana w manifeście przebiegu faza
  `parallel` osądzona została jednak jako `pending`
  (`parallel-requires-interleaved-sequence-numbers` -- przy dokładnie jednym żądaniu na agenta ten
  test nie może odróżnić realnego przeplotu od sekwencyjnego wywołania). Do
  [../tests/fixtures/capabilities/claude-code-2.1.267.json](../tests/fixtures/capabilities/claude-code-2.1.267.json)
  (nowa fikstura tej wersji, skopiowana z 2.1.266 z każdą sondą `pending`) `fixture-writer.ts`
  dopisał wyłącznie `M3-A: passed` z wpisem `diagnostics` wskazującym przebieg; `status`, `M10`,
  wszystkie fazy lifecycle i pozostałe sondy pozostają `pending`. `M10-freshness` zmierzył się jako
  `pending` z zerowymi licznikami rejestracji, zgodnie
  z przewidywaniem w [transport/GAPS.md](transport/GAPS.md). To nie jest promocja wsparcia; szczegóły
  w [transport/GAPS.md](transport/GAPS.md).
- Pierwszy realny pomiar faz `parallel` i `next-turn` (2026-09-10, realny klient `claude` 2.1.267,
  nowy tryb uruchomieniowy `next-turn` w `tests/probes/native-claude-run.sh`, przebieg
  `tests/probes/.runs/next-turn-jFdsmI`, osądzony przez `tests/probes/judge-run.ts`): tryb
  `next-turn` nadaje obu agentom-sondom narzędzie `Read` i wymusza na każdym dziecku drugie
  żądanie (wymuszony `tool_use` zamiast natychmiastowego echa na pierwszym żądaniu, prawdziwy
  `tool_result` dopiero uruchamia echo), dzięki czemu oba agenty wykonały po dwa przesłane dalej
  żądania każdy, na stabilnym modelu docelowym (bez dryfu), a ich żądania faktycznie się
  przeplotły w kolejności sekwencji. `judgeLifecyclePhase` zwrócił `passed` zarówno dla `parallel`,
  jak i dla `next-turn` (tryb w manifeście przebiegu zgodny z `next-turn`); `judgeM3A` również
  zwrócił `passed` na tym samym przebiegu. `fixture-writer.ts` dopisał wyłącznie
  `lifecycle.parallel: passed` i `lifecycle["next-turn"]: passed` do
  [../tests/fixtures/capabilities/claude-code-2.1.267.json](../tests/fixtures/capabilities/claude-code-2.1.267.json);
  `status`, `M10`, `M10-freshness` oraz pozostałe trzy fazy (`resume`, `compaction`, `nested`)
  nadal `pending`. `M10-freshness` ponownie zmierzył się jako `pending` z zerowymi licznikami
  rejestracji -- ten sam, już udokumentowany brak w bootstrapie, nie nowy problem. To nie jest
  promocja wsparcia; szczegóły w [transport/GAPS.md](transport/GAPS.md).
- Fazy `resume`, `compaction` i `nested` zmierzone (2026-09-10, realny klient `claude` 2.1.267 dla
  `resume` i `compaction`, 2.1.268 dla `nested`; przebiegi `tests/probes/.runs/resume-euk9s4`,
  `compaction-probe-*` i `nested-PogPYc`, osądzone przez `tests/probes/judge-run.ts`): wszystkie
  trzy pozostają `pending`, uczciwie. `resume` (dwa wywołania CLI, `--session-id` potem `-c`):
  identyfikator sesji jest zachowany, ale klient nadaje dziecku nowy `x-claude-code-agent-id` przy
  ponownej delegacji, więc żadne dziecko nie ma dwóch żądań przez granicę wznowienia. `compaction`:
  tryb `-p` nie skompaktował rozmowy pod `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (200 i 1000) ani
  `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=1`; zero znaczników `compact_boundary`. `nested`: przebieg trafił
  na samoczynną aktualizację klienta do 2.1.268, w której pierwsza wiadomość dziecka ma trzy bloki
  tekstowe zamiast dwóch, więc slot `after-native-context-v1` związany z wersją poprawnie odmówił
  routingu (`missing-selection`); nagłówek `x-claude-code-parent-agent-id` nadal niezmierzony.
  Dodano fiksturę `claude-code-2.1.268.json` z każdą sondą `pending`; fikstura 2.1.267 bez zmian.
  To nie jest promocja wsparcia; szczegóły w [transport/GAPS.md](transport/GAPS.md).
- `superpowers/specs/`: specyfikacje decyzji i wymaganych zachowań.
- `superpowers/plans/`: istniejący plan wykonania, nadal draft. Jego edycja nie uruchamia zadań ani nie zatwierdza wdrożenia.

## Docelowe bloki po wdrożeniu

Dopiero gdy powstanie działający, zweryfikowany blok, jego dokumentacja będzie zawierać pięć plików: `README`, `CONTRACTS`, `INVARIANTS`, `GAPS` i `OPERATIONS`. W razie potrzeb może dojść `DECISIONS`. `cli/`, `core/`, `catalog/`, `agents/` i `transport/` (opisane powyżej) są takimi blokami; każdy ma `verified_against` ze sprawdzonym commitem.

Te bloki nie są tworzone dla samego draftu. Nie zastępują ich spekulatywne opisy ani deklaracje weryfikacji nieistniejącego kodu.
