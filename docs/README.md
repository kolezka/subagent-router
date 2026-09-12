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
  `compaction-probe-*` i `nested-PogPYc`, osądzone przez `tests/probes/judge-run.ts`).
  At that checkpoint all three stayed `pending`, honestly; `nested` was measured later, on
  2026-09-11, see the entry below. `resume` (dwa wywołania CLI, `--session-id` potem `-c`):
  identyfikator sesji jest zachowany, ale klient nadaje dziecku nowy `x-claude-code-agent-id` przy
  ponownej delegacji, więc żadne dziecko nie ma dwóch żądań przez granicę wznowienia. `compaction`:
  tryb `-p` nie skompaktował rozmowy pod `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (200 i 1000) ani
  `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=1`; zero znaczników `compact_boundary`. `nested`: przebieg trafił
  na samoczynną aktualizację klienta do 2.1.268, w której pierwsza wiadomość dziecka ma trzy bloki
  tekstowe zamiast dwóch, więc slot `after-native-context-v1` związany z wersją poprawnie odmówił
  routingu (`missing-selection`). At that checkpoint `x-claude-code-parent-agent-id` had not been
  observed on any run; that clause is historical, the header was later observed on 2.1.267 and, on
  2026-09-11, on 2.1.268.
  Dodano fiksturę `claude-code-2.1.268.json` z każdą sondą `pending`; fikstura 2.1.267 bez zmian.
  To nie jest promocja wsparcia; szczegóły w [transport/GAPS.md](transport/GAPS.md).
- 2026-09-11: drugi zmierzony układ promptu rodzica, `after-native-context-v2` (trzy bloki
  tekstowe: instrukcje operatora, scaffold kontekstu, prompt delegacji), plus sonda `M3-A`
  zaliczona dla 2.1.268 w przebiegu `handler-yXSP4o` (oba dzieci zroutowane na
  `gateway/fast-worker` i `gateway/smart-worker`, bloki 0 i 1 przekazane bez zmian). Fikstura
  `claude-code-2.1.268.json` ma teraz `probes."M3-A": "passed"`. The clause that it does not declare
  `parentPromptPosition` is historical, true only until 2026-09-11; see the 2.1.268 lifecycle entry
  below. Szczegóły w
  [transport/GAPS.md](transport/GAPS.md).
- 2026-09-11: the `nested` lifecycle phase is measured and `passed` for 2.1.267 on a version-pinned
  run (`tests/probes/.runs/nested-gBXfBh`, launcher using the canonical versioned path for 2.1.267,
  judged by `tests/probes/judge-run.ts`). The parent decoded `PARENT_FINAL_OK` and the run produced
  a real grandchild whose request carried `x-claude-code-parent-agent-id` matching another observed
  child id; this run newly observes that header, superseding the earlier runs where it was absent.
  The clause that it stays unmeasured for 2.1.268 is historical; see the entry below.
  `fixture-writer.ts` narrowed exactly `lifecycle.nested: passed` into
  [../tests/fixtures/capabilities/claude-code-2.1.267.json](../tests/fixtures/capabilities/claude-code-2.1.267.json)
  with one `diagnostics` entry naming the run, and nothing was edited by hand. `status` stays
  `pending`, every probe other than the already-passing `M3-A` stays `pending` (`M10` and
  `M10-freshness` included), the `resume` and `compaction` phases stay `pending`, and
  `parentPromptPosition` is untouched, so this is not a support promotion. Full capture detail lives
  in [transport/GAPS.md](transport/GAPS.md).
- 2026-09-11: three pinned runs against real `claude` 2.1.268
  (`tests/probes/.runs/next-turn-UJqWfM`, `nested-uxI3hK`, `resume-D30trq`, judged by
  `tests/probes/judge-run.ts`) measured `lifecycle["next-turn"]`, `lifecycle.parallel` and
  `lifecycle.nested` as `passed` and reconfirmed `M3-A` as `passed` on all three.
  `writeCapabilityFixture` narrowed exactly those three lifecycle keys into
  [../tests/fixtures/capabilities/claude-code-2.1.268.json](../tests/fixtures/capabilities/claude-code-2.1.268.json),
  and `"parentPromptPosition": "after-native-context-v2"` was added there by hand under explicit
  operator approval, because the writer never emits that field. `lifecycle.resume` stays `pending`
  (the client issues a fresh child id on re-delegation) and `lifecycle.compaction` is UNMEASURED for
  this version: no run declared or exercised it. `status`, `M10`, `M10-freshness` and every probe
  other than the already-passing `M3-A` stay `pending`, so this is not a support promotion, and the
  production `claude-marker` gate still refuses 2.1.268 child requests at the `status` check. Full
  capture detail in [transport/GAPS.md](transport/GAPS.md).
- 2026-09-11: `M2` measured `failed` for 2.1.268. The `Agent` tool's `model` parameter is a
  schema enum of four aliases; a full model id (`gateway/probe-full-id`, `claude-haiku-4-5-20251001`)
  is rejected client-side with `InputValidationError` and no child is spawned, while the alias
  `haiku` in the same parameter does override the agent frontmatter. So native per-child model
  selection is limited to alias classes and the marker channel stays the only arbitrary-model path.
  `writeCapabilityFixture` set exactly `probes.M2: failed` in
  [../tests/fixtures/capabilities/claude-code-2.1.268.json](../tests/fixtures/capabilities/claude-code-2.1.268.json);
  nothing else changed. Details in [transport/GAPS.md](transport/GAPS.md).
- 2026-09-12: `lifecycle.compaction` measured `failed` for 2.1.268 (run
  `tests/probes/.runs/compaction-sbnVo0`, real `claude` 2.1.268 through the loopback capture
  gateway). The compaction really fired: each child's transcript gained one `compact_boundary`
  line and each child's next request opened with the client's continuation summary wrapper, with
  its message count down from 11 to 4. The compacted history dropped the channel-A marker from the
  first line of the delegation prompt, so the handler refused both post-compaction child requests
  with `422 missing-selection` and neither was forwarded. Upstream model was stable per child on
  every request that was forwarded. The `x-claude-code-agent-id` header survived the boundary, so a
  correlation binding keyed on it is the only known way to keep a child across a compaction, and
  that channel stays closed until `M1` is ruled on. The judge's compaction signal changed from the
  transcript-only `compact_boundary` marker to the wire wrapper, because the old predicate searched
  request bodies for a string that never reaches one. This is a failure, not a support promotion.
  Details in [transport/GAPS.md](transport/GAPS.md).
- 2026-09-12: M1 evidence for 2.1.268 and a compaction run under the agent-id correlation channel.
  Neither is narrowed into a fixture. The id generator was read straight out of the pinned binary
  `/Users/me/.local/share/claude/versions/2.1.268` with `dd`: 8 bytes from the Node CSPRNG
  `randomBytes` rendered as hex, so an unlabelled id is `a` plus 16 hex characters, 64 random bits,
  exactly the plan's "at least 64 bits" bar. The optional label that is new in this version adds no
  entropy. The id is minted once per spawn, rides in the `x-claude-code-agent-id` header, and stayed
  identical per child across compaction, `next-turn`, `parallel` and `nested`; eight children across
  four compaction runs of today produced eight distinct ids, and a fifth run added two more, no
  collision. `probes.M1` stays `pending` anyway: `judgeM1Sample` cannot return `passed` by its own
  type, its proof is always sample-based with `generatorInspected: false`, and no mechanism records
  a generator proof against a client version. Building one is an operator decision, RED first.
  Separately, run `tests/probes/.runs/compaction-up61gf` (same pinned binary and compaction mode as
  `compaction-sbnVo0`, plus `PROBE_CORRELATION_SCAFFOLD=1`) compacted both children three times
  each, forwarded every post-compaction request, and each child held its upstream model across every
  boundary, so the judge returns a passing `lifecycle.compaction` for that run.
  `writeCapabilityFixture` refuses a lifecycle pass from a run whose declared scaffold covers
  `probes.M1`, `correlation` or `correlationEntropy`, so
  [../tests/fixtures/capabilities/claude-code-2.1.268.json](../tests/fixtures/capabilities/claude-code-2.1.268.json)
  keeps `lifecycle.compaction: failed`, which is what production does today. `M3-A` judges `pending`
  on that run because post-compaction requests are not first-message envelopes, which is expected
  and does not touch the layout claim. This is not a support promotion; details in
  [transport/GAPS.md](transport/GAPS.md).
- 2026-09-12: `M1` is `passed` for 2.1.268, and `lifecycle.compaction` is `passed` with it. A
  generator proof for the pinned binary now exists
  ([../tests/fixtures/generator-proofs/claude-code-2.1.268.json](../tests/fixtures/generator-proofs/claude-code-2.1.268.json)):
  four dd-verified byte-exact sites, which `judgeM1` re-reads against that binary on every run, so
  a pass needs the proof to still describe the binary, a collision-free sample of at least two ids
  matching `^a[0-9a-f]{16}$`, and a generator drawing at least 64 bits. Run `compaction-sbnVo0`
  supplied the sample and narrowed `probes.M1: passed`, `correlation: true` and
  `correlationEntropy: passed`. Run `compaction-3slJXF` then repeated the failed compaction run on
  that real profile with no correlation scaffold (`correlationScaffold: false`): both children
  compacted three times each, every post-compaction request was forwarded on the child's own
  upstream model, nothing was refused, the parent decoded `PARENT_FINAL_OK`, and
  `writeCapabilityFixture` narrowed `lifecycle.compaction: passed` into
  [../tests/fixtures/capabilities/claude-code-2.1.268.json](../tests/fixtures/capabilities/claude-code-2.1.268.json).
  The bindings behind that pass are in-memory and idle-expiring, and production builds no
  correlation store until the profile is fully measured, so nothing changes for a running router
  yet; details in [transport/GAPS.md](transport/GAPS.md). `status` and `lifecycle.resume` stay
  `pending` and no profile is `supported`.
- `superpowers/specs/`: specyfikacje decyzji i wymaganych zachowań.
- `superpowers/plans/`: istniejący plan wykonania, nadal draft. Jego edycja nie uruchamia zadań ani nie zatwierdza wdrożenia.

## Docelowe bloki po wdrożeniu

Dopiero gdy powstanie działający, zweryfikowany blok, jego dokumentacja będzie zawierać pięć plików: `README`, `CONTRACTS`, `INVARIANTS`, `GAPS` i `OPERATIONS`. W razie potrzeb może dojść `DECISIONS`. `cli/`, `core/`, `catalog/`, `agents/` i `transport/` (opisane powyżej) są takimi blokami; każdy ma `verified_against` ze sprawdzonym commitem.

Te bloki nie są tworzone dla samego draftu. Nie zastępują ich spekulatywne opisy ani deklaracje weryfikacji nieistniejącego kodu.
