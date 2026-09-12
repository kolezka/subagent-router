# Routing modeli subagentów

Date: 2026-09-07

Status: draft (rewizja 6, do przeglądu)

## Cel

`subagent-router` ma umożliwić rodzicowi świadomy wybór modelu dla konkretnego natywnego subagenta bez zmiany modelu rodzica. Jedno uruchomienie może jednocześnie obsługiwać dzieci używające różnych modeli i różnych dostawców, o ile skonfigurowana brama je obsługuje.

Projekt ma być małym pakietem Bun + TypeScript. Ma działać jako biblioteka importowana przez inne narzędzia oraz samodzielnie przez CLI. Jest to jeden pakiet, nie monorepo.

Dokument opisuje proponowany projekt. Status `draft` nie oznacza akceptacji wszystkich szczegółów ani zgody na rozpoczęcie implementacji. Rewizja 2 zamknęła otwarte decyzje projektowe z rewizji 1 i zamieniła pozostałe luki na konkretne pomiary z kryteriami. Rewizja 3 dodaje projektowany, niezweryfikowany kontrakt katalogu modeli, odkrywania, podglądu tras i małego CLI. Rewizja 4 doprecyzowuje granice małego pakietu, skuteczny enforcement adapterów natywnych, ciągłość decyzji oraz transparentny transport. Rewizja 5 wskazuje zewnętrzną bramę, przede wszystkim `9router` lub OmniRoute, jako właściciela rozmowy z dostawcą i zakazuje zależności od pakietu `@the-next-ai/ai-gateway` używanego przez CCR. Nie oznacza to, że CLI, discovery ani routing runtime istnieją.

### Changelog rewizji 4

- Data dokumentu: 2026-09-07.
- Doprecyzowano granice odpowiedzialności pakietu, niezależność od KB oraz rozdzielenie AI SDK, własnego runtime i transparentny forwarding.
- Wzmocniono wymagania runtime dla adapterów OpenCode i Codex, w tym negatywną i pozytywną kontrolę M6-runtime oraz dowód skutecznego guardu M7.
- Uszczegółowiono kanały D2, zachowanie po utracie markera lub stanu tożsamości oraz kontrakt transparentnego HTTP.
- Dodano podprzypadek M10-freshness dla inicjalizacji defaultu i projektowany metadata sidecar eksportu native, który nie zastępuje dowodu runtime.
- Dodano macierze granic i adapterów oraz asercje strategii testów. Nie dodano implementacji. Nie wykonano pomiarów.

### Changelog rewizji 6

- Data dokumentu: 2026-09-09.
- Pomiar na Claude Code 2.1.266 wykazał, że pierwsza wiadomość `user` dziecka niesie dwa bloki tekstowe: blok 0 to kontekst natywny klienta (jedna lub więcej kompletnych sekcji `<system-reminder>` z pamięcią projektu i datą), blok 1 to prompt delegacji rodzica z markerem w pierwszej linii. Pozycja 2 z D2 czytała blok 0, więc kanał A kończył się `missing-selection`.
- Dodano wąski, profilowany wyjątek do pozycji 2: opcjonalne pole profilu `parentPromptPosition` z wartością `after-native-context-v1`, osobny pomiar `M3-A` i dokładne związanie wersji klienta z requestu z wersją załadowanego profilu. Wyjątek dotyczy wyłącznie wariantu rodzica. Kanały B i B2, M3 i M10 nie zmieniają się.
- Nie zmieniono wymagań 1-53, decyzji D1, D3-D11 ani pozostałych pomiarów. Nie promowano żadnego profilu; `M3-A` pozostaje `pending` dla obu zmierzonych wersji.

### Changelog rewizji 5

- Data dokumentu: 2026-09-08.
- Rozmowę z dostawcą prowadzi zewnętrzna brama, docelowo `9router` lub OmniRoute. LiteLLM lub inna brama o tym samym kontrakcie HTTP pozostaje dopuszczalna.
- Pakiet nie może zależeć od `@the-next-ai/ai-gateway`, pakietu bramy używanego przez CCR, ani osadzać innej biblioteki bramy. Brama działa jako osobny proces i endpoint HTTP. Powodem jest obserwowana przez operatora niska wydajność tego pakietu z dostawcą OpenAI oraz utrzymanie wymiany bramy jako zmiany konfiguracji.
- Dodano decyzję odrzucającą osadzenie bramy oraz asercję strategii testów dla tej granicy. Nie zmieniono wymagań 1-43 i 48-53, decyzji D1-D11 ani pomiarów M1-M10.

## Stan i zakres dowodów

Stan na 2026-09-06: repozytorium zawiera dokumentację, bez implementacji i testów routera. Nie wykonano testów E2E nowego zachowania. [verified]

### Wersje zmierzone lokalnie

Odczyt `--version` na maszynie autora, 2026-09-06. [verified]

| Narzędzie | Wersja lokalna | Najnowsze wydanie (GitHub API, 2026-09-06) |
|---|---|---|
| Claude Code | 2.1.263 | nie sprawdzano |
| OpenCode | 1.18.29 | v1.18.29, 2026-09-04 |
| Codex CLI | 0.150.0-alpha.8 | rust-v0.153.4, 2026-09-04 |
| Bun | 1.3.11 | nie sprawdzano |

### Claude Code

[verified] CCR ma istniejący mechanizm inspirujący. Symbol [`resolveBuiltInClaudeCodeSubagentRouteDecision`](https://github.com/kolezka/claude-code-router/blob/c49733678660f726540fca3fff20bbd7d6cab032/packages/core/src/gateway/claude-code-router-plugin.ts) wybiera model na podstawie tagu. Symbol [`extractAndRemoveClaudeCodeSubagentModelTag`](https://github.com/kolezka/claude-code-router/blob/c49733678660f726540fca3fff20bbd7d6cab032/packages/core/src/gateway/claude-code-router-plugin.ts) szuka tagu w blokach `system` oraz w co najwyżej dwóch pierwszych wiadomościach o roli `user`, a następnie usuwa go z requestu. Symbol [`removeClaudeCodeBillingSystemHeader`](https://github.com/kolezka/claude-code-router/blob/c49733678660f726540fca3fff20bbd7d6cab032/packages/core/src/gateway/claude-code-router-plugin.ts) rozpoznaje dziecko po metadanych `cc_is_subagent=true` w pierwszym bloku `system`.

[verified] Test CCR `"does not trust agent-id without billing metadata"` w [`router-builtins.test.mjs`](https://github.com/kolezka/claude-code-router/blob/c49733678660f726540fca3fff20bbd7d6cab032/packages/core/test/unit/gateway/router-builtins.test.mjs) pokazuje, że sam nagłówek `x-claude-code-agent-id` nie jest w CCR traktowany jako dowód pochodzenia od dziecka.

[verified] Binarium Claude Code 2.1.263 zawiera ciągi `x-claude-code-agent-id`, `cc_is_subagent`, `CLAUDE_CODE_SUBAGENT_MODEL` i `compact_boundary` (zliczone `grep -ac` na pliku wykonywalnym). Fragment kodu budującego nagłówki requestu API dodaje `x-claude-code-agent-id`, gdy kontekst requestu ma `agentId`, oraz `x-claude-code-parent-agent-id`, gdy ma `parentAgentId` (odczyt `grep -aoE` z kontekstem wokół nazwy nagłówka). Nie dowodzi to, że `agentId` jest ustawiony w każdym requeście dziecka, także po kompakcji. To jest przedmiot pomiaru M1.

[verified] Dokumentacja [Claude Code sub-agents](https://code.claude.com/docs/en/sub-agents), odczytana 2026-09-06, podaje kolejność wyboru modelu: parametr `model` wywołania, frontmatter `model` definicji, zmienna `CLAUDE_CODE_SUBAGENT_MODEL`, model rozmowy głównej. Fork oraz skill z `model: inherit` zawsze działają na modelu rozmowy głównej. Subagenty mają automatyczną kompakcję na tych samych zasadach co rozmowa główna. Parametr `model` wywołania obowiązuje także przy wznowieniu subagenta.

[verified] Dokumentacja [Claude Code hooks](https://code.claude.com/docs/en/hooks), odczytana 2026-09-06: pole `updatedInput` hooka `PreToolUse` nie dotyczy narzędzia `Agent`. Hook `SubagentStart` otrzymuje `agent_id` i `agent_type` oraz może zwrócić `additionalContext`, wstrzykiwany do kontekstu uruchamianego subagenta. Żaden hook nie otrzymuje ani nie zmienia modelu subagenta.

[verified] W sesji Claude Code 2.1.263, z której powstał ten dokument, schemat narzędzia `Agent` widoczny dla modelu ogranicza parametr `model` do aliasów `sonnet`, `opus`, `haiku`, `fable`. Dokumentacja dopuszcza także pełne identyfikatory w frontmatter. Rozbieżność między schematem a dokumentacją jest przedmiotem pomiaru M2.

[verified] CCR mapuje aliasy Claude Code na dowolne identyfikatory bramy przez zmienne środowiskowe, zobacz [`environment.ts`](https://github.com/kolezka/claude-code-router/blob/c49733678660f726540fca3fff20bbd7d6cab032/packages/core/src/agents/claude-code/environment.ts)`::"ANTHROPIC_DEFAULT_HAIKU_MODEL"`. Ten mechanizm daje najwyżej kilka klas modeli, nie dowolną liczbę modeli dzieci. [inferred]

### OpenCode

[verified] W OpenCode symbol [`TaskTool`](https://github.com/anomalyco/opencode/blob/337fd144d2ba144743368f78d9579a99cce175bd/packages/opencode/src/tool/task.ts) przyjmuje `subagent_type`, rozwiązuje go przez rejestr agentów i zwraca błąd `Unknown agent type` dla nieznanej nazwy. Model dziecka pochodzi z konfiguracji wybranego agenta albo z modelu rodzica. Narzędzie nie ma argumentu `model`.

[verified] Symbol [`Provider.getModel`](https://github.com/anomalyco/opencode/blob/337fd144d2ba144743368f78d9579a99cce175bd/packages/opencode/src/provider/provider.ts) zwraca `ModelNotFoundError`, gdy identyfikator modelu nie występuje w `models` skonfigurowanego providera. [inferred] Ścieżka Task rozwiązuje model agenta przez ten sam lookup, więc opaque identyfikatory bramy muszą być wpisane do konfiguracji providera. Pomiar M6 potwierdza to na działającym kliencie.

[verified] Hook pluginu `chat.headers` w [`request.ts`](https://github.com/anomalyco/opencode/blob/337fd144d2ba144743368f78d9579a99cce175bd/packages/opencode/src/session/llm/request.ts)`::"chat.headers"` otrzymuje `sessionID`, nazwę agenta, model i providera, a zwraca nagłówki dodawane do requestu. Hook `tool.execute.before` otrzymuje nazwę narzędzia, `sessionID`, `callID` i modyfikowalne `args`, zobacz [`index.ts`](https://github.com/anomalyco/opencode/blob/337fd144d2ba144743368f78d9579a99cce175bd/packages/plugin/src/index.ts).

[verified] Dokumentacja [OpenCode agents](https://opencode.ai/docs/agents/): model agenta ma format `provider/model`, subagent bez modelu dziedziczy model agenta wywołującego, definicje żyją w `opencode.json` albo w plikach Markdown w `.opencode/agents/` lub `~/.config/opencode/agents/`. Opcja `hidden` ukrywa agenta w autouzupełnianiu, ale nie blokuje użycia przez Task.

### Codex

[verified] Kod źródłowy Codex zawiera pole `model` w [`spawn_agent_common_properties_v1`](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/src/tools/handlers/multi_agents_spec.rs). W [`spawn.rs`](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/src/tools/handlers/multi_agents/spawn.rs)`::"effective_model"` model dziecka jest zwykłym ciągiem przekazywanym do konfiguracji wątku dziecka. Rola może nadpisać model, zobacz [`role.rs`](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/src/agent/role.rs). Nie znaleziono w tym kodzie nadpisania `model_provider` per dziecko, więc dziecko używa providera sesji. [inferred]

[verified] Dokumentacja [Codex hooks](https://learn.chatgpt.com/docs/hooks), odczytana 2026-09-06: hooki są włączone domyślnie, `PreToolUse` może zwrócić `hookSpecificOutput.updatedInput`, a matcher `Agent` obejmuje `spawn_agent`. Strona zastrzega, że schemat z gałęzi `main` może zawierać pola nieobecne w bieżącym wydaniu.

[verified] Dokumentacja [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents): `agents.default_subagent_model`, pliki ról w `~/.codex/agents/` lub `.codex/agents/` z polem `model`, jawne wartości spawn mają pierwszeństwo przed domyślnymi. Nie jest udokumentowany osobny `model_provider` dla dziecka.

[verified] Schemat konfiguracji `config.schema.json` na przypiętym commicie zawiera `ModelProviderInfo` z `base_url`, `wire_api`, `env_key`, `http_headers`, `env_http_headers`, `query_params` oraz sekcję agentów z `default_subagent_model`, `enabled`, `max_depth`. Opcjonalny `model_catalog` istnieje. Nie ustalono, czy nieznany identyfikator modelu bez katalogu jest odrzucany. To jest pomiar M5.

## Wymagania normatywne

### Produkt i granice

1. Pakiet MUSI być pojedynczym, małym pakietem Bun + TypeScript, bez monorepo, udostępnianym jako biblioteka importowana oraz przez CLI.
2. Core MUSI być czysty i importowalny bez obowiązkowego procesu serwera. Odpowiada wyłącznie za katalog modeli, lokalne opisy i aliasy, snapshoty przekazane przez callera oraz deterministyczną decyzję routingu.
3. Core NIE MOŻE zależeć od SDK harnessów ani wymagać AI SDK. Sama zależność od klienta SDK, jeżeli kiedyś zostanie użyta przez osobną integrację, nie oznacza, że router prowadzi własny agent loop.
4. Bun jest dozwolony w CLI i trybie standalone, ale core NIE MOŻE wymagać API specyficznego dla Bun.
5. Projektowany CLI `subagent-router` ma być małym interfejsem tekstowym do diagnostyki, offline preview, kontrolowanego eksportu i jawnego discovery snapshotu. NIE OBEJMUJE TUI, managera daemonów ani instalatora.
6. Żadna komenda NIE MOŻE automatycznie zmienić natywnych plików harnessu. Eksport zapisuje tylko do odrębnego katalogu artefaktów, nigdy do katalogu źródłowego agentów, także przy `--force`.
7. Projekt NIE MOŻE tworzyć własnego agent loop, wykonywania narzędzi, lifecycle dzieci, MCP runnera, embeddings, retrieval, code graph, magazynu wiedzy, schedulera, UI, managera daemonów ani bazy danych.
8. Projekt NIE OBEJMUJE auth kont dostawców, OAuth, translacji protokołów, provider-specific discovery, routingu dostawców ani automatycznego fallbacku do innego modelu. Odkrywanie katalogu przez CLI pozostaje oddzielną operacją, nie zależnością request-time.

### Wybór modelu

9. Rodzic MUSI móc wybrać model dla konkretnego dziecka z katalogu opisów opartego na snapshotcie załadowanym przez daną instancję.
10. Core MUSI walidować każdy jawny wybór względem snapshotu i `modelOverrides`.
11. Core MOŻE stosować jawne nadpisania tras istniejących ról oraz globalny model domyślny dzieci.
12. Core NIE MOŻE uruchamiać dodatkowego LLM ani automatycznego selectora do klasyfikacji zadania, wyboru modelu lub tworzenia opisu modelu.
13. Różne dzieci MUSZĄ móc używać różnych modeli i dostawców w tej samej sesji, o ile skonfigurowana brama je obsługuje.
14. Wybór dziecka NIE MOŻE zmieniać modelu rodzica.
15. Identyfikator `upstreamModel` MUSI być opaque i porównywany case-sensitive. Pakiet NIE MOŻE rozgałęziać logiki po nazwie vendora ani definiować `providers/*`; zmiana bramy nie może wprowadzać vendor branch do core lub handlera.
16. Katalog allowlist i definicje ról NIE MOGĄ być nadpisane promptem, historią ani wynikiem narzędzia. Jawny wybór rodzica z katalogu jest przekazywany autoryzowanym kanałem D2, a nie traktowany jako edycja konfiguracji.
17. Skonfigurowana rola sama w sobie NIE JEST dowodem, że dowolny request pochodzi od dziecka.

### Deterministyczne reguły decyzji

18. Dla dziecka objętego routingiem kolejność decyzji MUSI być następująca: jawny wybór, model domyślny konkretnej roli, globalny model domyślny dzieci. Niepoprawny jawny wybór NIE MOŻE przejść do wartości domyślnej.
19. Dziecko jest objęte routingiem, gdy adapter potwierdził jego pochodzenie i istnieje dla niego jawny wybór albo wcześniejsza decyzja skorelowana z tym samym dzieckiem. Rola z modelem domyślnym albo globalny model domyślny dzieci mogą zainicjować decyzję wyłącznie po potwierdzeniu świeżej delegacji przez podprzypadek M10-freshness. Niepoprawny marker w autoryzowanej pozycji jest błędem `invalid-marker`, nie brakiem markeru. Dziecko rozpoznane bez wskazania, a przy inicjalizacji defaultu także bez potwierdzonego sygnału świeżości, kończy się błędem `missing-selection`, bo router nie potrafi odróżnić dziecka nigdy nieobjętego routingiem od dziecka, które utraciło trasę po kompakcji, TTL albo restarcie handlera. Kanał inicjalizacji defaultu bez jawnego wyboru lub korelacji jest do czasu zaliczenia M10-freshness niewspierany i zwraca `missing-selection` albo `unsupported-path` zależnie od tego, czy request jest rozpoznanym dzieckiem, czy adapter próbuje uruchomić niezweryfikowaną drogę. Jedynym wyjątkiem jest jawny opt-in `defaults.unmarkedSubagent: "inherit"`, który przepuszcza takie dziecko z kodem `inherit-allowed`. Ten opt-in jest świadomą zgodą operatora na to, że utrata trasy będzie niewidoczna, i jest opisany w konfiguracji jako taka zgoda.
20. Parent bez dopasowania MUSI przejść pass-through bez zmiany modelu. Wyjątek opisany w D9 może idempotentnie wzbogacić wyłącznie kopię requestu parent o katalog i instrukcję wyboru w opisach `Agent`, `Task`, `Workflow` oraz polu `description` ich parametru `prompt`. Poza tymi tekstowymi polami opisów nie zmienia schematu narzędzi, ich dostępności, uprawnień, bloków `system` ani treści historycznych.
21. Jawnie routowane child z nieznanym modelem, modelem niedozwolonym, sprzecznymi markerami albo nieobsługiwaną ścieżką MUSI zakończyć się błędem.
22. W takich przypadkach NIE WOLNO cicho użyć modelu rodzica.
23. Pakiet NIE MOŻE automatycznie wybrać innego modelu po błędzie routingu.

### Model klienta i model upstream

24. Dokumentacja i kontrakty MUSZĄ rozróżniać `clientModel` od `upstreamModel`.
25. `clientModel` to ustawienie używane do walidacji, inicjalizacji harnessu i, gdzie obsługiwane, limitów właściwych dla klienta.
26. `upstreamModel` to model realnie wysyłany do skonfigurowanej bramy.
27. Natywny fork MOŻE odziedziczyć `clientModel`, a routing requestu MOŻE wybrać odmienny `upstreamModel`.
28. W trybie `marker-routed` wybór rzeczywistego modelu NIE MOŻE zależeć wyłącznie od natywnego pola modelu harnessu. W trybie `native` wybór jest oparty na dokładnym, resolved native model component równym `upstreamModel` zgodnie z wymaganiem 31, a wymaganie 33 opisuje obowiązkową walidację.
29. Przypadek fork z odziedziczonym `clientModel` i innym `upstreamModel` MUSI mieć osobny przypadek akceptacyjny.
30. Specyfikacja NIE twierdzi, że różne fork są już przetestowane.

### Tryby integracji

31. Każdy adapter MUSI deklarować jeden z dwóch trybów: `native`, gdy natywny resolver przekazuje dokładny `upstreamModel` jako effective model target, albo `marker-routed`, gdy `upstreamModel` ustala handler przed bramą. Reprezentacja `native` może wymagać prefiksu native providera, na przykład OpenCode `PROVIDER_ID/upstreamModel`; prefiks identyfikuje tylko skonfigurowanego native providera, a część modelu po rozstrzygnięciu przez native resolver pozostaje dosłownym, opaque `upstreamModel`.
32. OpenCode i Codex działają w trybie `native`. Claude Code działa w trybie `marker-routed`. Zmiana trybu adaptera wymaga rewizji specyfikacji.
33. W trybie `native` core nadal waliduje wybór względem allowlist i rozstrzyga defaulty, ale handler HTTP nie jest wymagany. Każdy adapter `native` MUSI wykonać runtime guard przed uruchomieniem dziecka: walidacja jawnego pola modelu musi skutecznie zatrzymać niedozwolony wybór, a model faktycznie użyty przez dziecko musi odpowiadać decyzji core. Ręcznie zintegrowany eksport może zastosować default, lecz rozstrzygnięty, a niewykazany jako zastosowany default roli albo globalny default nie jest wsparciem. Odziedziczony model parent nie staje się przez to nowym defaultem. Jeżeli harness w danej wersji nie daje skutecznego punktu zaczepienia, adapter MUSI odmówić działania dla tej wersji z kodem `unsupported-path`. Deklaratywne ograniczenie do ról, sam eksport ani czysta funkcja walidująca nie zastępują walidacji runtime, bo nie zatrzymują bezpośredniego podania modelu przez rodzica.

### Routing przed bramą

34. Warstwa routingu przed bramą jest częścią zakresu pierwszej implementacji dla trybu `marker-routed`.
35. Core, client adapters oraz cienki HTTP handler lub CLI `serve` MUSZĄ wspólnie zapewnić routing markerów dla Claude Code.
36. Aplikacja embed MUSI móc użyć tego samego handlera bez uruchamiania dodatkowego procesu proxy.
37. Handler MUSI wysyłać routing upstream do bramy skonfigurowanej przez caller lub środowisko.
38. Handler NIE MOŻE wyprowadzać URL upstream z promptu ani z request content.
39. Konfiguracja endpointu forwarding i nagłówków MUSI pochodzić od caller lub środowiska.
40. Sekrety NIE MOGĄ trafiać do promptów, markerów ani diagnostyki.
41. Handler MOŻE czytać routing JSON tylko dla obsługiwanych requestów.
42. Odpowiedzi i stream MUSZĄ być transparentnym pass-through: handler zachowuje bajty odpowiedzi, status, nagłówki end-to-end, SSE oraz nieznane ramki, błędy, tool i usage bez dekodowania, regenerowania, translacji protokołu lub pełnego buforowania.
43. Anulowanie, disconnect i backpressure streamu MUSZĄ przejść do upstream bez semantycznej zmiany. Handler przekazuje tylko istniejące requesty, nie wykonuje własnych generatywnych wywołań, retry ani fallbacku modelu. Wyłączna lista zmian kopii requestu upstream rozdziela trzy zakresy: dla każdego przekazywanego requestu zastosowanie endpointu i nagłówków wyłącznie od callera lub środowiska oraz niezbędne zmiany nagłówków transportowych; tylko dla rozpoznanego dziecka zmianę `model` na `upstreamModel`, usunięcie autoryzowanego markera i rozpoznanego technicznego bloku billing po odczytaniu jego provenance; dla requestu parent wzbogacenie wyłącznie pól opisów wskazanych w wymaganiu 20 i D9. Usunięcie billing z kopii requestu dziecka zapobiega przekazywaniu wewnętrznej metadanej harnessu do bramy. Zwykłe bloki `system` i reszta body oraz historii pozostają bez zmian. Ta lista nie pozwala zmieniać odpowiedzi ani streamu z wymagania 42.

### Niezależność od bramy

44. Rozmowę z dostawcą prowadzi zewnętrzna brama. Docelowe bramy to `9router` lub OmniRoute; LiteLLM lub inna brama o tym samym kontrakcie HTTP forwardingu i listy modeli jest dopuszczalna. Brama jest właścicielem protokołów, auth dostawców, OAuth, translacji i wyboru upstream.
45. `subagent-router` MUSI być niezależny od kodu i wewnętrznych baz każdej takiej bramy; korzysta wyłącznie ze skonfigurowanego kontraktu HTTP forwardingu i discovery, nie z jej modułów ani storage. Core oraz offline CLI nie zależą od dostępności bramy, lecz transparentny forwarding i jawne discovery wymagają dostępnej, skonfigurowanej bramy. Router pozostaje niezależny od kodu, danych i dostępności niezależnego KB opartego na Markdown/Git, PostgreSQL, Weaviate oraz CLI/MCP.
46. Pakiet NIE MOŻE zawierać adapterów bram, implementacji auth dostawców, routingu po vendorze, kodu KB, pobierania kontekstu ani uruchamiania MCP. Pakiet NIE MOŻE też zależeć od `@the-next-ai/ai-gateway`, pakietu bramy używanego przez CCR, ani od innego pakietu implementującego bramę, także jako zależność opcjonalna albo deweloperska używana przez kod produkcyjny. Natywny agent może korzystać z KB poza routerem.
47. Wymiana endpointu bramy przy tych samych opaque, case-sensitive model identifiers NIE MOŻE wymagać gałęzi kodu routera. Core przekazuje `upstreamModel` bez interpretacji vendora.

### Katalog i inspekcja

48. Model obecny w snapshotcie i włączony MOŻE być wybrany jawnie bez lokalnego opisu, ale bez opisu NIE MOŻE trafić do sugestii dla rodzica.
49. `modelOverrides` NIE MOŻE aktywować modelu nieobecnego w pobranym katalogu. Opis modelu oznaczonego jako `missing` pozostaje zachowany.
50. Upstream IDs i aliasy są porównywane case-sensitive. Upstream ID NIE MOŻE być przycinany, normalizowany ani wyprowadzany z aliasu. Nazwę roli dostarcza natywny resolver.
51. Wybór modelu `missing` albo wyłączonego MUSI zakończyć się jawnym błędem bez fallbacku.
52. Natywne definicje agentów, w tym `model: inherit`, MUSZĄ pozostać niezmienione. Podgląd nie zastępuje pomiaru modelu użytego przez działający harness.
53. CLI MUSI zapewniać inspekcję offline oraz maszynowe wyjście JSON. Komendy zapisujące mają jawny zakres zapisu i odrzucają konflikt współbieżnej edycji.

## Architektura i odpowiedzialności

### Macierz granic odpowiedzialności

| Obszar | Odpowiedzialność `subagent-router` | Poza zakresem lub właściciel |
|---|---|---|
| Core | Katalog modeli, lokalne opisy, aliasy, snapshoty, walidacja jawnego wyboru, deterministyczne defaulty i kody decyzji. | LLM selector, agent loop, wykonanie narzędzi i lifecycle dziecka należą do natywnego harnessu. |
| Adaptery Claude Code, OpenCode i Codex | Wiarygodne rozpoznanie dziecka, runtime guard przed dzieckiem w trybie `native` oraz przeniesienie decyzji core. | Zmiana native UI, uprawnień, narzędzi, lifecycle lub definicji źródłowych agentów. |
| Marker i cienki HTTP handler | Rozpoznanie autoryzowanego markera, korelacja ulotna, zmiana modelu dozwolonego requestu i transparentny forwarding. | Dekodowanie lub regenerowanie odpowiedzi, retry, fallback, generatywne call, protocol translation i provider routing. |
| CLI | Diagnostyka, offline preview, jawny sync snapshotu i kontrolowany eksport do osobnego katalogu. | TUI, scheduler, daemon manager, baza danych, automatyczna instalacja i zmiana aktywnych konfiguracji native. |
| Brama | Nie jest implementowana przez pakiet. | Zewnętrzny proces: docelowo `9router` lub OmniRoute, dopuszczalnie LiteLLM lub inna brama o tym samym kontrakcie HTTP. Obsługuje auth, OAuth, protokół, upstream i vendor routing. Pakiet `@the-next-ai/ai-gateway` z CCR nie jest zależnością routera. |
| KB | Router nie zależy od kodu, danych ani dostępności KB. | Niezależny KB Markdown/Git + PostgreSQL + Weaviate przez CLI/MCP, embeddings, retrieval, code graph i przechowywanie wiedzy. Natywny agent może go używać poza routerem. |

### Rozdzielenie AI SDK, runtime i forwardingu

AI SDK oznacza klienta SDK używanego przez callera lub osobną integrację do wywołań modelu. Sama zależność od SDK nie oznacza, że router prowadzi własny agent loop, wykonuje narzędzia, zarządza lifecycle lub routuje dostawców. Core i handler nie wymagają obowiązkowego AI SDK.

Własny runtime oparty na AI SDK byłby osobnym, niezamówionym zakresem. Nie należy dla niego tworzyć planu implementacji, runtime ani zmieniać nazwy repozytorium w ramach tego projektu. Projektowany handler przekazuje już otrzymany request transparentnie. Dekodowanie odpowiedzi SDK i jej regenerowanie nie może zastąpić transparentnego transportu, ponieważ narusza wymagania 42 i 43.

### Core

[assumption] Core przyjmuje znormalizowany kontekst requestu, katalog modeli i jawne informacje o pochodzeniu dziecka. Zwraca deterministyczną decyzję: pass-through, route do opaque `upstreamModel` albo opisany błąd.

Core odpowiada za:

- walidację katalogu i wyboru,
- rozstrzyganie defaultów,
- rozstrzyganie konfliktów w znormalizowanych wskazaniach modeli,
- odrzucanie wskazań, których pochodzenia adapter nie potwierdził,
- brak stanu współdzielonego między sesjami.

Rozpoznawanie wiadomości, markerów i tożsamości dziecka należy do adaptera klienta. Core nie analizuje surowej historii konkretnego harnessu.

Core nie odpowiada za:

- wywołanie harnessu,
- transport HTTP,
- auth, OAuth ani translację protokołu,
- wykrywanie możliwości dostawcy lub routing dostawcy,
- zarządzanie agent loop, wykonaniem narzędzi i lifecycle subagenta,
- KB, embeddings, retrieval, code graph, magazyn wiedzy, pobieranie kontekstu lub uruchamianie MCP.

### Client adapters

[assumption] Adapter tłumaczy wyłącznie lokalny kontrakt natywnego harnessu na wejście i wyjście core. Zachowuje natywne narzędzia, uprawnienia, UI i lifecycle danego harnessu.

Adapter MUSI:

- przekazać do core wiarygodne dane o bieżącym dziecku,
- przenieść decyzję do harnessu (tryb `native`) albo do routing handlera (tryb `marker-routed`) w obsługiwany sposób,
- odmówić jawnie, gdy nie potrafi bezpiecznie zachować wyboru,
- nie zmieniać modelu ani uprawnień rodzica.

Adapter NIE GWARANTUJE:

- tej samej jakości modelu,
- równych capabilities modeli,
- zgodnych limitów kontekstu,
- zgodnego formatu reasoning.

Ostatnie dwa punkty są zaakceptowanym ograniczeniem, opisanym w sekcji o limitach, nie podstawą do cichej zmiany `upstreamModel`.

### Routing handler

[assumption] Cienki handler rozpoznaje kontrolowany marker bieżącego dziecka, wylicza decyzję core, wykonuje wyłącznie zmiany wymienione w wymaganiu 43 na kopii upstream requestu i przekazuje istniejący request do skonfigurowanej bramy. Ten kontrakt jest projektowany, nie zmierzony runtime.

Oryginalna historia klienta i model rodzica NIE MOGĄ być mutowane. Handler NIE MOŻE uznać za upoważniony dowolnego markera odnalezionego w dawnej historii, tool results lub cytowanym tekście.

Handler zachowuje bajty odpowiedzi, status, nagłówki end-to-end oraz SSE, w tym nieznane ramki, błędy, tool i usage. Nie dekoduje odpowiedzi, nie regeneruje jej przez SDK, nie buforuje całego streamu, nie inicjuje generatywnego call i nie wykonuje retry ani fallbacku. Przenosi abort, disconnect i backpressure do upstream.

Handler utrzymuje wyłącznie ulotny stan routingu opisany w D2: korelację, jednorazowe dowody delegacji i ochronę ich nonce przed replay do końca ważności. Nie zapisuje niczego na dysk i nie zarządza lifecycle agenta.

[assumption] Dowód transparentności przekazanego `FetchLike` ma osobny `TransportCapabilityProfile` z polami `adapterId`, `runtimeVersion`, `status`, `gzipBytes` i `responseHeaders`. Profil dotyczy konkretnej implementacji transportu i wersji runtime, nie modelu ani vendora. Wszystkie wyniki wymagane przez dany kontrakt transportu muszą być `passed`; brak, `pending`, `failed` lub niezgodna tożsamość transportu powodują `unsupported-path` przy tworzeniu instancji handlera, czyli odmowę startu `serve` albo utworzenia handlera embed. To warunek uruchomienia transportu, nie błąd routingu nakładany na zwykły request rodzica. Pomiar obejmuje rzeczywistą odpowiedź gzip i zgodność bajtów oraz nagłówków, nie tylko fake fetch ani poprawienie nagłówków po dekompresji. Embed i CLI przekazują profil jawnie; zmiana transportu wymaga własnego dowodu. Handler nie wykonuje ukrytego self-probe ani discovery w request-time. Hermetyczny test może wstrzyknąć syntetyczny profil, ale nie zapisuje go jako dowodu wsparcia produkcyjnego runtime.

### Macierz adapterów, punktów kontroli runtime i odmowy

| Adapter | Tryb i punkt kontroli runtime | Wymagany dowód | Odmowa, gdy dowodu lub skutku brak |
|---|---|---|---|
| Claude Code | `marker-routed`; handler przed upstream requestem dziecka po wiarygodnym rozpoznaniu pochodzenia. | M1 dla korelacji i tożsamości, M3 dla kanału B, M10 oraz M10-freshness dla lifecycle i inicjalizacji defaultu. | `missing-selection`, `invalid-marker`, `correlation-conflict` albo `unsupported-path` zgodnie z brakującym warunkiem. |
| OpenCode | `native`; `tool.execute.before` przed uruchomieniem dziecka, bez modyfikacji `args` lub `subagent_type`; po native resolverze porównuje configured provider i exact `upstreamModel` osobno. | M6 i podprzypadek M6-runtime: rzeczywisty deny oraz odczyt authoritative effective config przed dzieckiem na każdej wspieranej drodze; M10 dla każdego wspieranego przejścia lifecycle i M10-freshness dla inicjalizacji defaultu. | `unsupported-path`; eksport, rola albo niewykazany default nie są fallbackiem. |
| Codex | `native`; zarejestrowany `PreToolUse` z matcherem `Agent` przed `spawn_agent`. | M5, M7 z rzeczywistym stdin/stdout, deny i odczytem authoritative effective config, M9 dla precedencji, M10 dla każdego wspieranego przejścia lifecycle oraz M10-freshness dla defaultu. | `unsupported-path`; sama rola, eksport lub obliczony default nie certyfikują wsparcia. |

Default core jest decyzją logiczną, nie uprawnieniem do mutacji `args`, `subagent_type` ani natywnych plików. Sukces adaptera `native` wymaga dowodu, że runtime załadował authoritative effective definition lub konfigurację zgodną z read-only metadata sidecar, jego `snapshotGeneration` i hashem artefaktu, że potwierdzona native precedence prowadzi do modelu równego decyzji core oraz że guard działa przed dzieckiem. Eksport może przygotować artefakt do ręcznej integracji, który po rzeczywistym załadowaniu może zastosować default. Brak zastosowanego lub nieweryfikowalnego eksportu oznacza gate pomiaru i `unsupported-path`; odziedziczony model parent nie jest nowym defaultem.

### Konfiguracja

Projekt rozdziela operatorowy plik `subagent-router.json` od generowanego snapshotu `models.lock.json`. Core przyjmuje te same już wczytane obiekty od callera, więc aplikacja embed nie musi czytać plików ani środowiska. Dokładny format opisuje „Decyzja D4”.

Konfiguracja MUSI rozdzielać:

- `clientModel`, gdy adapter go potrzebuje,
- exact opaque `upstreamModel` ze snapshotu,
- opcjonalne `routeOverrides` istniejących effective agent names,
- operatorowe opisy, aliasy i status modeli,
- endpoint oraz referencje do auth i nagłówków wyłącznie w konfiguracji operatora lub środowisku,
- snapshot katalogu bez sekretów i bez surowej odpowiedzi bramy.

## Kontrakty i invariants

`enforcement: brak implementacji`. Poniższe kontrakty opisują wymagania, nie istniejące zabezpieczenia. Docelowo decyzję i allowlist sprawdzają testy core, pochodzenie i ciągłość wyboru testy adapterów, a rzeczywisty model oraz transport testy handlera i E2E.

### Kontrakt decyzji routingu

Dla każdego obsługiwanego requestu core zwraca dokładnie jeden wynik:

1. `pass-through` dla rodzica albo dla dziecka objętego jawnym opt-in dziedziczenia. Wynik niesie kod diagnostyczny `parent` albo `inherit-allowed` oraz listę zignorowanych markerów z pozycji nieautoryzowanych jako `ignored-marker`.
2. `route` z jednym zwalidowanym opaque `upstreamModel` dla rozpoznanego dziecka. Wynik niesie źródło decyzji: `explicit`, `role-default`, `global-default`, `correlated`.
3. `error` dla dziecka objętego routingiem, gdy wybór jest niepoprawny, brakujący albo nieobsługiwany. Wynik niesie kod błędu: `unknown-model`, `model-not-allowed`, `invalid-marker`, `conflicting-markers`, `correlation-conflict`, `unsupported-path`, `missing-selection`.

Nie istnieje wynik znaczący „spróbuj modelu rodzica”.

### Invariant izolacji rodzica

Model rodzica, jego uprawnienia, narzędzia i lifecycle pozostają bez zmian. Zmiana modelu dotyczy wyłącznie requestu zakwalifikowanego jako konkretne dziecko. Wyjątek D9 może idempotentnie wzbogacić wyłącznie kopię requestu parent o stały katalog i instrukcję wyboru w opisach `Agent`, `Task`, `Workflow` oraz opisie promptu. Nie zmienia innych schema fields, narzędzi, uprawnień, bloków `system` ani treści historycznych.

### Invariant wiarygodnego pochodzenia

Marker jest sygnałem transportowym umieszczonym w autoryzowanej pozycji przez rodzica albo adapter dla bieżącego dziecka. Nie jest instrukcją tekstową dla modelu i nie może być zaakceptowany, gdy występuje tylko w nieautoryzowanej części danych requestu. Marker pochodzący od adaptera niesie token uwierzytelniający, marker pochodzący od rodzica jest związany z pozycją początku promptu delegacji. Autoryzowane pozycje wylicza sekcja „Decyzja D2”. Skutek każdego przyjętego markeru jest ograniczony do allowlist, więc najgorszy skutek nadużycia to wybór innego dozwolonego modelu, nigdy modelu spoza katalogu ani innej bramy.

### Invariant braku wycieku decyzji

Równoległe i zagnieżdżone dzieci, a także niezależne sesje, nie dzielą wyboru modelu. Anulowanie jednej sesji nie może zmienić decyzji drugiej. Pamięć korelacji jest kluczowana identyfikatorem konkretnego dziecka razem z identyfikatorem instancji handlera i nigdy nie jest dziedziczona przez inne dziecko. Kolizja identyfikatora z odmiennym markerem jest błędem `correlation-conflict`, nie cichym przejęciem decyzji.

### Invariant przejrzystej porażki

Dla dziecka objętego routingiem brak bezpiecznej trasy kończy obsługę błędem przed wywołaniem upstream. Nie powoduje zastąpienia modelu modelem rodzica. Zwykły ruch rodzica i dzieci nieobjętych routingiem pozostaje bez zmian.

### Invariant transportu

Po podjęciu decyzji handler wykonuje wyłącznie zmiany kopii upstream requestu wymienione w wymaganiu 43. Poza nimi przekazuje body, odpowiedź, stream, anulowanie i backpressure bez translacji protokołu.

## Decyzje rozstrzygające luki rewizji 1

### Decyzja D1: dwa tryby integracji zamiast jednego mechanizmu dla wszystkich harnessów

Rozstrzyga lukę 6 i lukę 7 w części projektowej.

W OpenCode model agenta `provider/model` jest wysyłany do skonfigurowanego providera, a według odczytu źródła identyfikator musi istnieć w katalogu `models` tego providera, co ma potwierdzić pomiar M6. [assumption] Projektowany kontrakt adaptera OpenCode zakłada reprezentację `PROVIDER_ID/upstreamModel`: `PROVIDER_ID` wskazuje skonfigurowanego native providera, a model zwrócony przez dostępny native resolver musi być exact opaque `upstreamModel`. Guard porównuje osobno zgodność `PROVIDER_ID` z konfiguracją oraz exact model ID z decyzją core. Nie porównuje całego qualified string jako modelu i nie usuwa ani nie normalizuje segmentów samego `upstreamModel`; przykładowe `gateway/gateway/fast-worker` oznacza providera `gateway` oraz opaque ID `gateway/fast-worker`. M6-runtime musi dowieść tej reprezentacji, dostępności native resolvera dla guardu i rzeczywistego porównania przed child spawn. W Codex model podany w `spawn_agent` albo w roli jest przekazywany jako ciąg do providera sesji. W obu przypadkach effective model target po native resolverze jest dosłownie `upstreamModel`, więc marker i handler nie są potrzebne. Bramą jest jeden skonfigurowany provider: dla OpenCode wpis providera OpenAI-compatible z `baseURL`, dla Codex `model_providers.<id>` z `base_url`.

W Claude Code natywne pole modelu jest ograniczone do aliasów albo identyfikatorów akceptowanych przez klienta, a hooki nie mogą zmienić modelu subagenta. Dlatego Claude Code wymaga trybu `marker-routed`: rodzic wybiera z katalogu, marker trafia do dziecka, handler przed bramą podmienia `upstreamModel`.

Konsekwencja: handler HTTP jest w pierwszej implementacji potrzebny tylko dla Claude Code. Core i konfiguracja są wspólne dla wszystkich trzech harnessów.

### Decyzja D2: kanały routingu i składnia markeru dla Claude Code

Rozstrzyga lukę 4 i lukę 9.

Marker ma postać jednego znacznika w jednej linii i występuje w dokładnie dwóch wariantach gramatyki:

```text
<subagent-router v="1" model="ALIAS"/>
<subagent-router v="1" role="NAME" agent="AGENT_ID" token="HMAC"/>
```

Zasady:

- `v` to wersja składni. Nieznana wersja w autoryzowanej pozycji jest błędem `invalid-marker`.
- Wariant rodzica ma wyłącznie atrybuty `v` i `model`. `model` to bezpieczny lokalny alias, nie upstream ID. Alias ma regex `^[A-Za-z][A-Za-z0-9_-]{0,126}$` i jest unikalny w bieżącym snapshotcie. Adapter mapuje alias na exact opaque ID przed wywołaniem core. Dzięki temu marker przyjmuje upstream IDs zawierające spacje lub Unicode, a upstream ID nigdy nie jest zmieniane.
- Wariant adaptera ma wyłącznie atrybuty `v`, `role`, `agent` i `token`. `role` to nazwa roli z konfiguracji, `agent` to identyfikator dziecka znany hookowi, `token` to HMAC liczony z sekretu wspólnego dla adaptera i handlera na tej samej maszynie nad ciągiem `v|role|agent`. Token obejmuje więc każde pole, które wpływa na routing. Sekret pochodzi ze środowiska, nigdy z pliku konfiguracji ani z promptu.
- Każde odstępstwo od tych dwóch gramatyk w autoryzowanej pozycji, w tym mieszanie atrybutów obu wariantów, niedozwolone znaki, brak zamknięcia albo nieznany atrybut, to błąd `invalid-marker`, nie brak markeru.
- Markery są klasyfikowane według źródła: `explicit` dla wariantu rodzica, `role-default` dla wariantu adaptera. Między źródłami obowiązuje kolejność z wymagania 18, więc marker rodzica wygrywa z markerem roli. Dwa różne markery z tego samego źródła to błąd `conflicting-markers`. Identyczne markery są traktowane jak jeden.
- Składnia jest własnością tego projektu. Nie ma zgodności drop-in ze znacznikiem CCR.

Autoryzowane pozycje markeru:

1. Bloki `system` requestu, wyłącznie dla wariantu adaptera z poprawnym `token`, którego `agent` zgadza się z identyfikatorem dziecka w requeście. Wariant rodzica, marker bez tokenu albo z błędnym tokenem w bloku `system` jest ignorowany z kodem `ignored-marker`. Ta zasada chroni przed markerem przemyconym przez treść `CLAUDE.md`, instrukcje projektu albo inny tekst systemowy, którego adapter nie wystawił.
2. Pierwsza linia pierwszego bloku tekstowego pierwszej wiadomości o roli `user`, o ile ta wiadomość nie zawiera bloków `tool_result`. To jest początek promptu delegacji napisanego przez rodzica i przyjmowany jest tu wyłącznie wariant rodzica. Wariant adaptera w tej pozycji jest przyjmowany wyłącznie po zaliczeniu M3, które potwierdza dokładnie tę pozycję oraz poprawny token. Przed zaliczeniem M3 extraction klasyfikuje taki wariant adaptera jako `ignored-marker`; wynik `pending`, brak ścieżki albo brak dowodu nie uprawnia do jego przyjęcia. Wtedy obowiązuje ta sama weryfikacja tokenu co w bloku `system`. Marker w dalszej części tej wiadomości jest ignorowany z kodem `ignored-marker`.

Marker w dowolnej innej pozycji, w tym w blokach `tool_result`, w późniejszych wiadomościach i w treści odpowiedzi asystenta, jest ignorowany. Rodzic z cytowanym markerem przechodzi pass-through.

Wyjątek pozycji 2 dla zmierzonego prefiksu natywnego (rewizja 6). [verified 2026-09-09, Claude Code 2.1.266] Klient wstawia własny kontekst do bloku tekstowego 0 pierwszej wiadomości `user`, a prompt delegacji rodzica do bloku 1. Profil może to zadeklarować polem `parentPromptPosition: "after-native-context-v1"`; brak pola albo `first-text` oznacza wyłącznie pozycję 2 w dotychczasowym brzmieniu. Alternatywny slot jest brany pod uwagę tylko gdy jednocześnie: profil ma to jawne ustawienie, `M3-A` ma wynik `passed`, a wersja klienta odczytana z requestu (token wersji w `user-agent` postaci `claude-cli/x.y.z`) jest identyczna z niezmienną wersją załadowanego profilu. Handler nie przeładowuje profilu per request; niezgodność albo brak wersji cofa do pozycji legacy. Slot wymaga dokładnie dwóch bloków tekstowych w tej wiadomości, bez innych bloków; blok 0 musi w całości pasować do gramatyki scaffoldu: jedna lub więcej kompletnych, niezagnieżdżonych sekcji `<system-reminder>`, każda z drugą linią będącą zdaniem wprowadzającym harnessu i co najmniej jednym nagłówkiem kontekstu `# nazwa`, bez tekstu przed pierwszym otwarciem i po ostatnim zamknięciu poza pustymi liniami. Przyjmowany jest wyłącznie wariant rodzica z pierwszej linii bloku 1; pozycja legacy ma pierwszeństwo, gdy sama niesie marker. Blok 0 jest przekazywany dalej bez zmian, usuwana jest tylko przyjęta linia markeru z bloku 1. Marker w dalszej części bloku 1 albo wewnątrz bloku 0 jest `ignored-marker`. Wariant adaptera w tym slocie nigdy nie jest przyjmowany, niezależnie od `adapterMarkerPosition` i M3. Rozpoznanie publicznego wrappera to rozpoznanie formatu, nie uwierzytelnienie: request HTTP o tym samym kształcie może wskazać model tak samo, jak mógł w pozycji legacy, a skutek pozostaje ograniczony do allowlist zgodnie z ryzykiem resztkowym powyżej.

Wyjątek pozycji 2 dla zmierzonego prefiksu natywnego, układ v2. [verified 2026-09-11, Claude Code 2.1.268] Klient 2.1.268 przesuwa własny scaffold kontekstu do bloku tekstowego 1, a do bloku 0 wstawia pliki instrukcji operatora jako dokładnie jedną kompletną sekcję `<system-reminder>`, której druga linia zaczyna się od zdania `Codebase and user instructions are shown below.`; prompt delegacji rodzica zostaje w bloku 2 z markerem w pierwszej linii. Profil deklaruje ten układ polem `parentPromptPosition: "after-native-context-v2"`. Warunki otwarcia slotu są identyczne jak dla v1: jawne ustawienie w profilu, `M3-A` z wynikiem `passed` oraz wersja klienta odczytana z requestu identyczna z niezmienną wersją załadowanego profilu. Slot wymaga dokładnie trzech bloków tekstowych, bez innych bloków; blok 0 musi pasować do gramatyki instrukcji: jedna kompletna, niezagnieżdżona sekcja `<system-reminder>`, druga linia zaczynająca się od tego zdania jako prefiksu (klient dopisuje w tej samej linii dalsze zdania), co najmniej jeden nagłówek `# nazwa` wewnątrz, poza pustymi liniami nic przed otwarciem i nic po zamknięciu. Blok 1 musi pasować do tej samej gramatyki scaffoldu, której wymaga v1. Przyjmowany jest wyłącznie wariant rodzica z pierwszej linii bloku 2; pozycja legacy ma pierwszeństwo, gdy sama niesie marker. Bloki 0 i 1 są przekazywane dalej bez zmian, usuwana jest tylko przyjęta linia markeru z bloku 2. Marker w dalszej części bloku 2 albo wewnątrz bloków 0 i 1 jest `ignored-marker`. Wariant adaptera w tym slocie nigdy nie jest przyjmowany, niezależnie od `adapterMarkerPosition` i M3. Każdy układ pasuje wyłącznie do własnej liczby bloków: profil v1 nigdy nie czyta wiadomości trzyblokowej, a profil v2 nigdy dwublokowej, więc niezgodność cofa do pozycji legacy i kończy się `missing-selection`. Rozpoznanie obu wrapperów to rozpoznanie formatu, nie uwierzytelnienie; ryzyko resztkowe kanału rodzica jest takie samo jak w v1. `M3-A` dla 2.1.268 zostało zmierzone jako `passed` (przebieg `handler-yXSP4o`, `PROBE_LAYOUT=v2 PROBE_PROFILE_BASE=real`, dwie pary dziecka, wszystkie sześć warunków spełnione). Status note, 2026-09-11 (English): the clause that `claude-code-2.1.268.json` has no `parentPromptPosition` field is historical, true only until 2026-09-11. That fixture now declares `"parentPromptPosition": "after-native-context-v2"`, added by hand, so the v2 slot is declared for this version. Production still refuses every 2.1.268 child request: `assertCapability` stops at `status: "pending"`, and `M10`, `M10-freshness`, `lifecycle.resume` and `lifecycle.compaction` stay `pending`.

Ryzyko resztkowe kanału rodzica: rodzic, który skopiuje obcy tekst z markerem do pierwszej linii własnego promptu delegacji, wybiera ten model tak, jakby zrobił to sam. Skutek jest ograniczony do allowlist. Specyfikacja przyjmuje to ryzyko, bo rodzic jest z założenia stroną wybierającą, a instrukcja narzędzia delegacji każe umieszczać marker jako pierwszą linię własnego tekstu.

Kanały, którymi wybór dociera do dziecka:

- Kanał A, jawny wybór rodzica: rodzic umieszcza marker jako pierwszą linię promptu delegacji. Opis narzędzia delegacji, dostarczony przez adapter jako idempotentne uzupełnienie kontekstu rodzica, wymienia tylko aktywne modele z lokalnym opisem, ich aliasy i składnię. Prompt delegacji jest pierwszą wiadomością `user` każdego kolejnego turnu świeżego subagenta, więc wybór jest widoczny w każdym requeście bez pamięci po stronie handlera. [inferred z pozycji parsowania CCR i z budowy rozmowy subagenta]
- Kanał B, domyślny model roli: hook `SubagentStart` adaptera zna `agent_id` i `agent_type`, liczy `token` i wstrzykuje wariant adaptera markeru przez `additionalContext`. Dzięki temu rola ma model domyślny nawet wtedy, gdy rodzic nie wskazał modelu. Kanał B wolno włączyć wyłącznie po zaliczeniu M3, które potwierdza dokładną autoryzowaną pozycję markera oraz token, i M10-freshness, które potwierdza nową delegację przed inicjalizacją defaultu. Każde użycie B wymaga zgodnego `x-claude-code-agent-id` dla tego samego `agent_id`; obecność i ciągłość nagłówka muszą wynikać z M1 albo z dokładnego dowodu M3 dla wybranej pozycji. Brak zgodnego nagłówka unieważnia zaufanie do markera: extraction zwraca `ignored-marker`, a rozpoznane dziecko dalej podlega wymaganiu 19. Wynik `pending`, brak ścieżki albo brak dowodu oznacza `unsupported-path` tylko dla próby włączenia kanału B, nie blanketową odmowę każdego requestu. Jeżeli M3 wykaże, że `additionalContext` nie trafia do bloku `system` ani do pierwszej wiadomości `user`, adapter może przejść na kanał B2: hook rejestruje parę `agent_id` i rola bezpośrednio w handlerze przez lokalny endpoint uwierzytelniony tym samym sekretem. B2 wymaga wcześniej zaliczonego M1, M10-freshness oraz `harness.claudeCode.correlation: "auto"` jako dowodu wiarygodnej tożsamości `agent_id` i nowej delegacji; `off` nie może pośrednio włączyć stanu B2. Rejestracja nie jest substytutem ani obejściem guardów kanału C. Każdy request B2 nadal wymaga potwierdzonego pochodzenia dziecka i zgodności tożsamości. Kanał B2 nie zależy od treści promptu.
- Kanał C, korelacja po identyfikatorze dziecka: przy pierwszym routowanym requeście handler zapamiętuje parę identyfikator dziecka i decyzja w ulotnej mapie procesu z limitem czasu. Kolejne requesty z tym samym identyfikatorem i potwierdzonym pochodzeniem zachowują już związaną decyzję ze źródłem `correlated`, także gdy kompakcja usunęła marker z historii. Identyfikator pochodzi z nagłówka `x-claude-code-agent-id`. Claude Code nie wysyła osobnego identyfikatora sesji, więc klucz nie może zawierać sesji, a bezpieczeństwo kanału opiera się na losowości identyfikatora dziecka. Kanał C jest aktywny tylko wtedy, gdy pomiar M1 potwierdzi dla danej wersji obecność nagłówka w każdym requeście dziecka oraz losowość identyfikatora wystarczającą, by kolizja między sesjami była praktycznie niemożliwa. Adapter przechowuje listę wersji z zaliczonym M1 i nie ma ustawienia, które włącza kanał C bez tego zaliczenia. Bez zaliczenia kanał C jest wyłączony, a utrata markera kończy się według wymagania 19.

Pochodzenie od dziecka potwierdza wyłącznie `cc_is_subagent=true` w metadanych billing, tak jak w CCR. Nagłówek identyfikatora agenta służy korelacji, nie uwierzytelnieniu pochodzenia. Request z korelowanym identyfikatorem, który niesie poprawny marker o innej decyzji, kończy się błędem `correlation-conflict`, bo wskazuje na kolizję identyfikatora albo próbę przejęcia.

Pamięć korelacji: mapa w pamięci procesu, klucz to identyfikator instancji handlera i identyfikator dziecka, wartość to już zwalidowana decyzja, jej źródło i znacznik czasu, limit czasu konfigurowalny z domyślną wartością jednej godziny od ostatniego użycia, brak zapisu na dysk. Restart handlera gubi mapę. Utrata markera przy zachowanym, związanym identyfikatorze zachowuje poprzednią decyzję, a marker z inną decyzją kończy się `correlation-conflict`. Utrata jednocześnie markera i stanu tożsamości po restarcie ujawnia lukę defaultów: router NIE MOŻE po restarcie wybrać dla tego samego dziecka nowego modelu z defaultu roli ani defaultu globalnego. Odzyskanie starej decyzji wymaga świeżego autoryzowanego wskazania. Świeży default wymaga dowodu nowej delegacji bez wcześniejszego wyboru. Sama identyfikacja bieżącego dziecka ani bieżącej ścieżki nie jest takim dowodem. W przeciwnym razie adapter zwraca `missing-selection`; jedyny wyjątek to jawny, potwierdzony opt-in `defaults.unmarkedSubagent: "inherit"`. To jest akceptowane jako błąd widoczny, nie jako cicha zmiana modelu. Kanał A odtwarza decyzję z promptu delegacji, dopóki kompakcja go nie usunie.

Podprzypadek M3-B2 w ramach M3 osobno sprawdza lokalną rejestrację hooka: poprawny HMAC, zgodność `agent_id`, zakończenie rejestracji przed pierwszym requestem oraz odrzucenie błędnego tokenu i konfliktu roli. Jest nadal niewykonany. Wynik ujemny M3 dotyczący położenia `additionalContext` nie zalicza M3-B2. Kanał B2 wymaga pozytywnego M3-B2 oprócz M1, `correlation: "auto"` i M10-freshness dla inicjalizacji defaultu; nie wymaga pozytywnego wyniku testu położenia markera w body.

Podprzypadek M10-freshness jest wymaganym, nadal niezweryfikowanym gate dla każdego adaptera, który chce zainicjować default bez jawnego wyboru lub korelacji. [assumption] Przed pierwszym requestem dziecka adapter musi uzyskać z wiarygodnego zdarzenia harnessu dowód nowej delegacji związany z konkretnym `agent_id`, odróżnialny od resume, compaction, ponownego użycia wpisu po TTL i restartu handlera. Sama długość historii, brak `compact_boundary`, bieżąca ścieżka lub obecność requestu nie są dowodem świeżości. Do czasu zaliczenia M10-freshness kanał inicjalizacji defaultu bez jawnego wyboru albo korelacji jest niewspierany według wymagania 19. Marker roli B zachowany po zniknięciu markera jawnego i restarcie nie może sam zainicjować ponownie defaultu bez nowego, potwierdzonego sygnału świeżości.

Dowód świeżości jest osobnym wejściem adaptera, nie polem `args`, promptu, historii ani wyniku narzędzia. HMAC istniejącego markera `v|role|agent` potwierdza wyłącznie wskazanie roli i nie autoryzuje świeżości. Jeśli hook przekazuje dowód do handlera kanałem kontrolnym, wymaga on oddzielnej domeny uwierzytelnienia z sekretu operatora, powiązania z instancją handlera i konkretnym dzieckiem, krótkiego TTL oraz jednorazowego użycia. Ponowienie starego markera lub dowodu po użyciu, wygaśnięciu albo restarcie nie może zainicjować nowego defaultu. M10-freshness sprawdza zarówno producenta dowodu w natywnym harnessie, jak i konsumenta w adapterze lub handlerze. Do czasu tego pomiaru nie wolno uznać samego `SubagentStart` ani poprawnie podpisanego zgłoszenia za dowód nowej delegacji. Nie zmienia to gramatyki markerów D2 i nie wprowadza trwałego magazynu stanu.

[assumption] Projektowany producent to wykonywalny hook Claude czytający natywne zdarzenie ze stdin, nie wywołanie generatywne. Po zaliczeniu M10-freshness przekazuje jednorazowy dowód do konsumenta handlera niezależnie od tego, czy model domyślny roli przenosi marker B, czy rejestr B2. `GET /subagent-router/control/instance` udostępnia niesekretny `handlerInstanceId`; `POST /subagent-router/control/delegations` przyjmuje `{ version, handlerInstanceId, agentId, role, nonce, issuedAtMs, proof }`. Podpis jest HMAC-SHA-256 nad kanoniczną tablicą JSON `["subagent-router:freshness:v1", version, handlerInstanceId, agentId, role, nonce, issuedAtMs]`, z istniejącego `secretEnv`. Ta domena różni się od podpisu markera roli. Handler sprawdza podpis, instancję, tożsamość, czas i brak replay, a `consumeFreshDelegation(agentId)` atomowo zużywa dowód przy pierwszej decyzji tego dziecka. Niezgodność roli między dowodem świeżości, autoryzowanym markerem B lub wpisem B2 dla tego samego `agentId` kończy się `conflicting-markers`, nigdy wyborem jednego z tych źródeł. Dowód zużyty przy błędnej decyzji nie jest przywracany. Wpis ma ograniczony TTL, nie dłuższy od TTL korelacji; zużyty nonce jest chroniony przed ponownym użyciem do końca ważności podpisanego dowodu. Restart unieważnia poprzednią instancję. Endpointy kontrolne nigdy nie są przekazywane do bramy, a `proof` nie trafia do diagnostyki. Bez działającego, zmierzonego producenta hook nie wytwarza dowodu świeżości, nawet jeśli umie wygenerować poprawny marker B. Eksport hooka i jego konfiguracji podlega niezmienionemu kontraktowi read-only native files i osobnego katalogu artefaktów.

### Decyzja D3: fork w Claude Code jest poza gwarancją pierwszej implementacji

Rozstrzyga lukę 2 w części projektowej.

Fork dziedziczy model, kontekst i historię rozmowy głównej. Prompt delegacji forka nie jest pierwszą wiadomością `user`, więc kanał A go nie obejmuje. Nie wiadomo, czy `SubagentStart` uruchamia się dla forka ani czy request forka niesie `cc_is_subagent=true`. Bez tych faktów nie da się bezpiecznie odróżnić forka od rodzica.

Decyzja: pierwsza implementacja nie obiecuje routingu forków. Request forka bez rozpoznanego pochodzenia jest traktowany jak rodzic i przechodzi pass-through. Request forka z rozpoznanym pochodzeniem, ale bez wskazania, podlega wymaganiu 19 jak każde inne dziecko. Kryterium akceptacyjne 6 pozostaje w specyfikacji jako cel drugiego etapu i zależy od pomiaru M4. Wymagania 27 do 30 pozostają w mocy jako opis docelowy.

### Decyzja D4: rozdzielony config operatora i snapshot katalogu

Rozstrzyga lukę 8 oraz projektuje kontrakt discovery. Ten kontrakt jest wymagany dla przyszłej implementacji, ale nie jest jeszcze zweryfikowany przeciw działającej bramie ani CLI.

`subagent-router.json` jest plikiem operatora. Zawiera referencje do źródła katalogu, lokalne nakładki modeli i trasy ról, lecz nie zawiera ręcznej listy modeli ani sekretów:

```json
{
  "version": 1,
  "modelSource": {
    "sourceId": "primary-gateway",
    "baseUrlEnv": "SUBAGENT_ROUTER_GATEWAY_URL",
    "endpointPath": "/v1/models",
    "authEnv": "SUBAGENT_ROUTER_MODELS_AUTH",
    "headersEnv": ["SUBAGENT_ROUTER_MODELS_HEADERS"],
    "timeoutMs": 10000,
    "fetchLimit": 1000,
    "staleAfterSeconds": 86400
  },
  "modelOverrides": {
    "gateway/fast-worker": {
      "alias": "fast",
      "description": "Szybkie zadania mechaniczne i wyszukiwanie.",
      "enabled": true,
      "clientModel": "haiku"
    }
  },
  "roles": {
    "claude-code:explorer": { "routeOverride": "gateway/fast-worker" }
  },
  "defaults": {
    "child": null,
    "unmarkedSubagent": "error"
  },
  "agentRoots": {
    "claude-code": { "configRoot": null },
    "opencode": { "configRoot": null },
    "codex": { "configRoot": null }
  },
  "gateway": {
    "urlEnv": "SUBAGENT_ROUTER_GATEWAY_URL",
    "headersEnv": ["SUBAGENT_ROUTER_GATEWAY_HEADERS"]
  },
  "harness": {
    "claudeCode": { "correlation": "auto", "secretEnv": "SUBAGENT_ROUTER_SECRET" },
    "opencode": { "providerId": "gateway" },
    "codex": { "emitModelCatalog": false }
  }
}
```

`models.lock.json` jest generowanym, atomowym snapshotem po udanym `models sync`:

```json
{
  "version": 1,
  "sourceId": "primary-gateway",
  "sourceFingerprint": "96b80377b311dc1765bde8e0ec7bae4efa848497ad0245cfb927653ba2d0527b",
  "fetchedAt": "2026-09-06T12:00:00Z",
  "models": [
    {
      "id": "gateway/fast-worker",
      "alias": "m-6414d01405c95a7bd2b2a13b415d7685a1673f800ca90dd031a5eeb1776dc81d",
      "status": "available",
      "metadata": { "displayName": "Fast worker" }
    }
  ]
}
```

Zasady:

- `sourceId` jest nadanym przez operatora identyfikatorem źródła. `sourceFingerprint` to SHA-256 UTF-8 zwartej tablicy JSON `[sourceId, effectiveGatewayUrl, effectiveModelsUrl]`. Efektywne URL są kanoniczne, bez końcowego `/`; URL z userinfo, query lub fragmentem są odrzucane, a auth trafia wyłącznie do nagłówków. Dzięki temu zmiana endpointu przy niezmienionym `sourceId` także unieważnia snapshot. Fingerprint przykładu wyliczono dla `https://gateway.example/v1` oraz `https://gateway.example/v1/models`; nie jest to pomiar bramy.
- Snapshot przechowuje exact opaque `id`, deterministyczny alias `m-` plus hash SHA-256 UTF-8 ID oraz minimalne metadane. NIE przechowuje całej odpowiedzi bramy, auth, nagłówków ani zmiennych środowiskowych. Metadane bramy nie są zaufanym opisem ani instrukcją dla rodzica.
- Domyślny alias to `m-` oraz pełny hash SHA-256 UTF-8 dokładnego ID. Nakładka może zastąpić go aliasem spełniającym regex markera. Kolizja aliasów, także z ID innego modelu, jest błędem konfiguracji. CLI przyjmuje ID albo alias, ale zapisuje referencje jako dokładne ID. Zmiana aliasu nie zmienia referencji ról ani danych źródła. Ręczny alias nie jest wymagany.
- `modelOverrides[id]` może ustawić tylko `description`, `alias`, `enabled` i `clientModel`. Nakładka dla nieobecnego ID pozostaje zachowana jako nieaktywna, nie dodaje modelu do allowlist. `enabled` domyślnie oznacza `true` tylko dla `status: available`. Lokalny opis zaginionego modelu można nadal edytować. `--clear` usuwa opis i wyklucza model z sugestii, bez przejmowania opisu providera. Brak `clientModel` lub wartość `inherit` nie blokuje routingu.
- `roles` zawiera opcjonalne wpisy dla istniejących nazw w formacie `<client>:<effective-name>`, na przykład `claude-code:explorer`. Pole `routeOverride` wskazuje dokładny upstream ID, nigdy alias ani nową definicję roli. Referencja do nieistniejącej roli, modelu `missing` lub wyłączonego jest błędem `config check`; osierocony opis bez trasy jest tylko ostrzeżeniem. Klienci to `claude-code`, `opencode` i `codex`.
- `agentRoots.<client>.configRoot` jest jawnym rootem przekazywanym do natywnego resolvera. `null` oznacza reguły aktywnego harnessu. Nie tworzy własnej precedencji.
- `baseUrlEnv`, `endpointPath`, auth i nagłówki są wyłącznie operatorową konfiguracją lub środowiskiem. Wartość z promptu, wpisu modelu lub odpowiedzi discovery NIE MOŻE zmienić URL ani nagłówków.
- `endpointPath` domyślnie wynosi `/v1/models`. Konstrukcja endpointu używa segmentów URL i nie dokleja `/v1` drugi raz, gdy `baseUrlEnv` już kończy się `/v1`. Zmieniony path pozostaje literalną konfiguracją operatora.
- Caller przekazuje do biblioteki już sparsowane `operatorConfig`, `catalogSnapshot` i wynik native resolvera. Core nie czyta plików, środowiska ani sieci.
- Nieznane pola, nieznana `version`, inline header values i snapshot o niezgodnym `sourceId` lub `sourceFingerprint` są błędami walidacji.
- `defaults.child` wskazuje dokładny ID modelu domyślnego albo `null`. `defaults.unmarkedSubagent` przyjmuje `error` lub jawne `inherit`, które wymaga `defaults.unmarkedSubagentAcknowledged: true`. Semantykę utraty trasy określa wymaganie 19.
- `gateway.urlEnv` wskazuje URL upstream. Pola `gateway.headersEnv` i `modelSource.headersEnv` wskazują zmienne z obiektami JSON string-to-string. Opcjonalne `modelSource.authEnv` zawiera token Bearer do endpointu modeli. Zduplikowane nazwy nagłówków z różnych źródeł, niezależnie od wielkości liter, są błędem zamiast niejawnego nadpisania. Żadnych rozstrzygniętych wartości auth ani nagłówków CLI nie wypisuje.
- `harness.claudeCode.correlation` przyjmuje `auto` lub `off`; `auto` dopuszcza korelację tylko dla wersji z zaliczonym M1. `secretEnv` wskazuje sekret hooka, nigdy jego wartość w pliku. `harness.opencode.providerId` wskazuje natywnego providera dla eksportowanych wariantów. `harness.codex.emitModelCatalog` włącza eksport katalogu z dostępnych modeli, jeśli wymaga tego wynik M5.
- Zmiana `sourceId` albo endpointu wymaga jawnego pełnego synchronizowania. Brak snapshotu wskazuje `models sync`, nigdy nie powoduje ukrytego pobrania w request-time.
- Sync nie zmienia pliku operatora. Nowe ID jest dostępne dopiero po pełnym udanym sync. Snapshot zachowuje zniknięte wpisy jako `status: missing`, bez prawa routingu. Ponowne pojawienie się dokładnego ID przywraca `available`; opis i alias operatora pozostają zachowane. `--allow-empty` dopuszcza brak aktywnych wpisów, nie usuwa ich opisów ani tras.
- `models.lock.json` leży obok wskazanego pliku `--config`. Domyślny config to `./subagent-router.json`, bez niejawnego scalania plików nadrzędnych. Czytelnik ładuje i waliduje pełną parę config/snapshot. Zapis sprawdza wersję wejściową obu plików przed zatwierdzeniem i odrzuca konflikt, zamiast nadpisywać równoległą edycję.
- Aktywne `serve` ładuje niezmienny config oraz snapshot przy starcie i pokazuje ich hash jako `snapshotGeneration`. CLI preview pokazuje generację plików, nie trwającego procesu. Nowe opisy, aliasy i modele wymagają nowej instancji, nie przełączają bieżących sesji. Projekt nie zakłada hot reloadu ani schedulera.
- [assumption] Eksport `native` zapisuje w katalogu artefaktów read-only metadata sidecar, nie nieznane pole w natywnym pliku agenta. Sidecar zawiera `snapshotGeneration` jako hash config/snapshot oraz hash każdego wyeksportowanego artefaktu native. Guard otrzymuje ten sidecar przez konfigurację eksportu tylko do odczytu. Sam sidecar potwierdza wyłącznie zgodność artefaktu z eksportem, nie to, że harness faktycznie go załadował. M6-runtime i M7 muszą przed spawn odczytać authoritative effective config lub definition harnessu; brak takiego zaczepienia oznacza `unsupported-path`.

### Decyzja D5: OpenCode używa istniejących ról i eksportu do ręcznej integracji

Rozstrzyga lukę 6.

Adapter odczytuje istniejące natywne definicje OpenCode jako źródło ról. Gdy wybór wymaga wariantu `ROLE@ALIAS`, `config export --client opencode` może wyeksportować taki wariant wraz z fragmentem katalogu providera wyłącznie do wskazanego katalogu artefaktów. Użytkownik integruje artefakt ręcznie. Eksport nigdy nie podmienia pliku bazowego, nie dopisuje modeli do aktywnego `opencode.json` i nie tworzy roli za usunięty lub niedostępny plik.

Wariant zachowuje prompt, narzędzia, uprawnienia i tryb definicji źródłowej, zmienia jedynie nazwę, opis, `hidden` i model `PROVIDER_ID/upstreamModel`. Opis może korzystać wyłącznie z lokalnego `description`, nie z opisu bramy. Brak natywnej definicji roli jest jawnym błędem eksportu albo preview, nie sygnałem do wygenerowania zastępstwa.

Plugin `chat.headers` jest opcjonalny wyłącznie dla nagłówka diagnostycznego z nazwą agenta do requestów. Guard pluginu `tool.execute.before` jest obowiązkowy dla wspieranej wersji OpenCode, jeżeli podprzypadek M6-runtime wykaże, że potrafi skutecznie odmówić przed uruchomieniem dziecka. Po native resolverze guard waliduje zgodność configured `PROVIDER_ID` oraz exact model ID z decyzją core, nie całe `PROVIDER_ID/upstreamModel`; nie usuwa ani nie normalizuje segmentów `upstreamModel` i nie podmienia ukrycie `args` ani `subagent_type`. Brak ścieżki, brak dowodu skutecznej odmowy albo brak pokrycia obsługiwanej drogi oznacza `unsupported-path`, nie wsparcie oparte wyłącznie na eksporcie lub wariancie roli.

Eksport jest artefaktem do ręcznej integracji, a ręcznie zintegrowany i faktycznie aktywny eksport może zastosować default natywny. Przed deklaracją wsparcia adapter musi przez M6-runtime zweryfikować, że authoritative effective definition lub konfiguracja rzeczywiście została załadowana i że odpowiada read-only metadata sidecar z właściwą `snapshotGeneration` oraz hashem artefaktu. `config check` offline pokazuje tylko poprawność, symulację i potencjalny mismatch albo `unknown`, nie dowód native application. Jeżeli default wariantu nie został zastosowany albo nie da się go zweryfikować, adapter odmawia z `unsupported-path`; odziedziczony model parent nie jest nowym defaultem roli.

Warunek zaliczenia obejmuje M6 oraz M6-runtime: M6 potwierdza dziedziczenie promptu, narzędzi i uprawnień oraz zachowanie modelu wariantu po wznowieniu, a M6-runtime potwierdza skuteczny guard przed dzieckiem.

### Decyzja D6: Codex używa istniejących ról, hooka walidującego i eksportu

Rozstrzyga lukę 7.

Rodzic podaje `model` w `spawn_agent` jako opaque identyfikator bramy. Hook `PreToolUse` z matcherem `Agent` jest obowiązkową częścią adaptera: waliduje `model` względem snapshotu i odrzuca niedozwolony model przez `permissionDecision: "deny"`. Hook NIE stosuje `updatedInput` do podmiany modelu, bo byłoby to fallbackiem sprzecznym z wymaganiem 23. M7 musi potwierdzić zarejestrowany hook w wydanym Codex, rzeczywisty kształt stdin i stdout oraz skuteczną odmowę przed uruchomieniem dziecka i przed requestem upstream. Czysta funkcja walidująca albo tylko poprawnie sformatowany plik hooka nie są dowodem runtime guardu.

`config export --client codex` może przygotować role z domyślną trasą oraz opcjonalny `model_catalog` w osobnym katalogu artefaktów, gdy M5 to uzasadni. Nie modyfikuje `config.toml`, katalogu natywnych ról ani istniejącej roli. Usunięta lub niedostępna rola nie może zostać zastąpiona nową rolą o tej samej nazwie. Ręcznie zintegrowany i faktycznie aktywny eksport może zastosować default natywny, ale nie jest wsparciem, dopóki M7 nie potwierdzi, że runtime odczytał authoritative effective definition lub konfigurację zgodną z read-only metadata sidecar, jego `snapshotGeneration` i hashem artefaktu oraz że model po native precedence odpowiada decyzji core.

Jeżeli M7 wykaże, że hook nie otrzymuje `model`, że kształt stdin lub stdout nie pozwala na skuteczny guard albo że `deny` nie zatrzymuje uruchomienia dziecka, adapter Codex odmawia działania dla tej wersji z kodem `unsupported-path`, zgodnie z wymaganiem 33. Tryb „tylko role” nie jest dopuszczalnym zamiennikiem, bo nie zatrzymuje bezpośredniego `spawn_agent` z modelem spoza snapshotu. Rola lub globalny default obliczony, lecz niewykazany jako zastosowany w runtime, kończy się `unsupported-path`; odziedziczony model parent nie jest nowym defaultem.

Precedencja między jawnym `model` w `spawn_agent` a modelem roli nie wynika jednoznacznie ze źródła. Pomiar M9 ją ustala. Do czasu zaliczenia M9 ta ścieżka jest `pending` i nie certyfikuje wsparcia na podstawie założenia, także gdy dokumentacja sugeruje pierwszeństwo jawnej wartości. Brak dowodu dla wspieranej wersji oznacza `unsupported-path`; wynik M9 inny niż decyzja core także oznacza `unsupported-path`.

Wersja bazowa: dokumentacja hooków opisuje zachowanie wydania, więc adapter wymaga wydanego Codex w wersji co najmniej `rust-v0.153.4`. Lokalna wersja `0.150.0-alpha.8` jest niższa i musi zostać zaktualizowana przed pomiarami M5, M7 i M9.

### Decyzja D7: limity kontekstu i format reasoning są zaakceptowanym ograniczeniem

Rozstrzyga lukę 5.

Pakiet nie zarządza limitami kontekstu ani formatem reasoning. W trybie `marker-routed` klient inicjalizuje limity według `clientModel`, a brama obsługuje `upstreamModel`. Rozjazd jest możliwy i celowo nie jest korygowany po stronie routera. Łagodzenie: pole `clientModel` w katalogu pozwala dobrać alias klienta bliski klasie modelu upstream, a handler zapisuje w diagnostyce parę `clientModel` i `upstreamModel` dla każdej decyzji.

Ta decyzja zamyka lukę jako świadomie przyjęte ograniczenie. Pomiar M8 jest informacyjny: nie bramkuje statusu `implemented`, ale jego wynikiem musi być tabela w dokumentacji bloku z przetestowanymi parami `clientModel` i `upstreamModel` oraz obserwowanym zachowaniem przy długim kontekście.

### Decyzja D8: wersje bazowe

Rozstrzyga lukę 1.

Wersje bazowe pierwszej implementacji to wersje zmierzone w tym dokumencie: Claude Code 2.1.263, OpenCode 1.18.29, Codex co najmniej rust-v0.153.4, Bun 1.3.11. Adapter deklaruje wersję bazową w kodzie i odmawia działania z kodem `unsupported-path`, gdy wykryta wersja jest niższa. Nowsza wersja może otrzymać ostrzeżenie w diagnostyce, ale ostrzeżenie nie obchodzi wymagania 33, właściwych pomiarów ani braku dowodu wsparcia. Niezweryfikowana ścieżka nowszej wersji pozostaje `unsupported-path` do czasu zaliczenia właściwych scenariuszy akceptacyjnych.

### Decyzja D9: natywne definicje agentów są read-only źródłem ról

Ta decyzja rozszerza D5 i D6. Kontrakt jest wymagany, ale niezweryfikowany w działających resolverach wszystkich harnessów.

- Claude odczytuje projektowe `.claude/agents` oraz katalog `agents` aktywnego katalogu konfiguracji. Standardowo jest to `~/.claude/agents`, ale resolver respektuje `CLAUDE_CONFIG_DIR` i jawny `configRoot`.
- OpenCode i Codex odczytują swoje natywne źródła wyłącznie przez adaptery.
- `--agents-dir` dodaje jawny read-only root dla komend inspekcyjnych i eksportu. Nie zmienia plików ani nie definiuje własnej hierarchii.
- Dokładna precedencja, namespace i effective name należą do natywnego resolvera harnessu. Router nie wymyśla kolejności katalogów. Frontmatter `name` albo namespace może różnić się od nazwy pliku.
- Inspekcja pokazuje source path, scope, effective name, declared model, w tym `inherit`, oraz shadowed entries. Gdy adapter nie może potwierdzić modelu runtime, pokazuje `unknown`, nie zgaduje.
- Built-in, pluginowe i dynamiczne agenty bez pliku mają ograniczoną widoczność jako `fileless`. Pusty skan katalogu nie oznacza, że nie istnieją. Gdy dostępny jest natywny tool schema, adapter pobiera z niego znane role.
- Nieznanej lub usuniętej roli nie wolno odtwarzać przez generator. `hidden` oznacza widoczność interfejsu, nie nieistnienie roli. Rola `fileless` potwierdzona przez resolver może być pokazana i użyta w preview; eksport wymagający jej niedostępnej pełnej definicji zgłasza ograniczenie zamiast odtwarzać instrukcje.

Dla Claude router nie generuje zamienników agentów ani `model` per plik. Idempotentnie dodaje katalog opisanych modeli i instrukcję wyboru wyłącznie do opisów narzędzi rodzica `Agent`, `Task` i `Workflow`, a także do pola opisu promptu, jeżeli taki kanał istnieje. Wzbogacenie następuje tylko w kopii requestu parent przekazywanej przez handler i stanowi stały baseline dla kryteriów 4 oraz 23. Zachowuje wszystkie inne schema fields, narzędzia, uprawnienia, bloki `system` i historię. Rodzic zapisuje wybrany alias w markerze, a handler obsługuje marker requestu dziecka. To jest podstawowy sposób jawnego wyboru, niezależny od skuteczności `PreToolUse.updatedInput`. Hooki ról są tylko optymalizacją lub defaultem.

### Decyzja D10: automatyczne discovery i snapshot offline

Discovery pobiera katalog wyłącznie z konfigurowalnego endpointu modeli bramy. Standardowy endpoint ma path `/v1/models` i kontrakt JSON `{"data":[{"id":"nonempty string"}]}`. Projekt nie deklaruje, że jakakolwiek konkretna brama została nim sprawdzona.

- Synchronizacja wymaga poprawnej pozytywnej kontroli, schematu i niepustych, unikalnych IDs. Powtarzające się ID są błędem.
- Projektowany profil stronicowania przyjmuje `has_more: true` z niepustym `next_cursor`; kolejne pobranie na ten sam endpoint używa parametru `cursor`. `has_more: false` kończy pobieranie. Zwykłe `data` bez metadanych stronicowania oznacza pełną listę w tym kontrakcie. Sprzeczne lub nierozpoznane sygnały dalszych stron, brak kursora, powtarzający się kursor i cykl stron są błędami. Jest to wybrany profil adaptera, nie twierdzenie o standardzie wszystkich bram.
- Limit pobrania jest konfigurowalny. Jego przekroczenie jest błędem. Timeout, auth failure, zły JSON, niepełna paginacja i nieoczekiwanie pusty katalog nie zastępują ostatniego poprawnego snapshotu.
- Pełny snapshot zapisuje się atomowo tylko po sukcesie. Pusty snapshot można zapisać wyłącznie z `--allow-empty`.
- Redirect na inny origin jest odrzucany przed przekazaniem credentials. Żadna wartość z odpowiedzi nie steruje URL, auth ani headers.
- Ostatni poprawny snapshot może działać offline, lecz `list`, `show`, `preview`, `doctor` i `serve` pokazują `fetchedAt` oraz ostrzeżenie `stale`, gdy odpowiedni próg konfiguracji został przekroczony.
- Core request-time, `route preview` i komendy inspekcji domyślnie nie wykonują sieci. W warstwie zarządzania sieć wykonuje tylko jawne `models sync` lub `doctor --connect`. Transport requestów przez `serve` pozostaje oddzielną funkcją handlera. Pozytywna kontrola schematu jest wymogiem testów discovery, a nie dodatkowym ukrytym requestem CLI.

### Decyzja D11: projektowany interfejs CLI i podgląd trasy

Poniższe komendy są projektowanym interfejsem. Nie istnieją jeszcze i nie stanowią instrukcji uruchomienia runtime.

| Komenda | Odczyt | Sieć | Zapis |
|---|---|---:|---:|
| `models sync [--dry-run] [--allow-empty]` | operator config i endpoint modeli | tak | tylko `models.lock.json` po udanym sync bez `--dry-run`; pokazuje `added`, `changed`, `missing` |
| `models list`, `models show <id-or-alias>` | config i snapshot | nie | nie; pokazuje ID, alias, opis, source, status i czas snapshotu |
| `models describe <id-or-alias> --text "..." \| --file <path> \| --clear` | config i snapshot | nie | tylko opis w `modelOverrides`, atomowo; konflikty współbieżnej edycji są odrzucane |
| `agents list --client <client>`, `agents show <name> --client <client>` | native resolver i explicit roots | nie | nie; pokazuje effective precedence, scope, declared model i router override |
| `route preview --client <client> --agent <name> [--model <id-or-alias>] [--parent-model <model>]` | config, snapshot, native resolver i core | nie | nie; symuluje uwierzytelniony kontekst dziecka |
| `config show`, `config check` | config, snapshot i resolver | nie | nie; pokazuje provenance, schema, refs, metadata sidecar oraz potencjalny mismatch lub `unknown`, ale nie dowód native application |
| `config export --client <client> --output <dir> [--dry-run]` | config, snapshot i native definitions | nie | tylko osobne fragmenty, overlaye i przykłady do ręcznej integracji |
| `doctor [--connect]` | config, snapshot, ścieżki i dostępność | tylko z `--connect` | nie; `--connect` sprawdza endpoint modeli i schema bez completion ani uruchamiania agenta |
| `serve` | config i snapshot przy starcie | zgodnie z projektowanym handlerem | brak automatycznych aktualizacji snapshotu |

Dodatkowe zasady projektowanego CLI:

- `models describe` ma dokładnie jeden z trybów `--text`, `--file` albo `--clear`. Edycja opisu zaginionego ID z zachowaną nakładką jest dozwolona, ale nie aktywuje ID.
- `route preview` nie uruchamia agenta, nie wysyła promptu i nie wywołuje narzędzi. Wynik jest oznaczony jako `simulation` i zawiera wybrany model lub default, powód, alias, exact `upstreamModel`, `clientModel` albo `unknown`, a także błędy `missing` i `disabled`. `--parent-model` jest dosłownym wejściem symulacji. Preview nie zgaduje modelu rodzica ani nie składa deklaracji o bieżącym runtime.
- `config export` odrzuca katalog źródłowy agentów zawsze, również z `--force`. Porównuje rzeczywiste ścieżki po rozwiązaniu symlinków i nie zapisuje przez link poza katalog eksportu. `--force` pozwala tylko zastąpić uprzednio obejrzany artefakt eksportu w dozwolonym katalogu. Eksport czyta snapshot offline i nigdy nie modyfikuje globalnego lub natywnego configu.
- `doctor` rozróżnia stan skonfigurowany, zmierzony i `pending E2E`. Sukces `config check` albo `doctor` nie jest gwarancją kompatybilności modeli ani dowodem, że native harness załadował artefakt eksportu.
- Globalne opcje to `--config`, `--json`, `--help`, `--version`, `--no-color` oraz `--client` tam, gdzie dotyczy. `--client` przyjmuje `claude-code`, `opencode` lub `codex`. `--agents-dir` dotyczy inspekcji ról, preview i eksportu. Argumenty ID zawierające spacje należy cytować, na przykład `--model 'gateway/Model with spaces'`.
- `list`, `show` i `agents` pokazują także nieaktywne wpisy i błędne referencje, zamiast ukrywać je za błędem całego katalogu. Brak snapshotu nie blokuje samej inspekcji plików agentów, ale wybór trasy wymaga snapshotu. `config check` waliduje również referencje tras. Żadna komenda nie wypisuje rozstrzygniętych wartości auth, sekretu ani nagłówków, także przy błędzie lub `--json`.
- Przy `--json` stdout zawiera wyłącznie dane maszynowe. Progress i błędy trafiają na stderr bez sekretów. Exit code to `0` dla sukcesu, także `--dry-run` z diffem, `1` dla błędu operacyjnego i `2` dla błędu użycia, konfiguracji lub wyboru. Gdy stdout nie jest TTY albo użyto `--no-color`, CLI nie emituje ANSI. Dane katalogu i opisów są renderowane z escapowaniem znaków sterujących; reprezentacja terminalowa nie zmienia przechowywanego upstream ID.

## Pomiary wymagane przed statusem implemented

Każdy pomiar ma kryterium rozstrzygające. Wynik ujemny nie unieważnia projektu, tylko wyłącza wskazany kanał albo przenosi funkcję do drugiego etapu.

| Id | Pytanie | Metoda | Kryterium | Skutek wyniku ujemnego |
|---|---|---|---|---|
| M1 | Czy Claude Code 2.1.263 wysyła `x-claude-code-agent-id` w każdym requeście dziecka, także po kompakcji, i czy identyfikator jest losowy oraz unikalny między sesjami i uruchomieniami? | Kontrolowana brama zapisuje nagłówki wszystkich requestów subagentów w dwóch równoległych sesjach, jednej wznowionej i jednej z wymuszoną kompakcją. Osobny dowód z implementacji albo kontrolowanego generatora identyfikatora potwierdza co najmniej 64 bity entropii, ponieważ sam format nie jest takim dowodem. | Nagłówek obecny i stały w każdym requeście danego dziecka; identyfikatory różne między dziećmi, sesjami i uruchomieniami; capture potwierdza ciągłość, a osobny dowód potwierdza generator o co najmniej 64 bitach entropii. | Kanał C wyłączony dla tej wersji; utrata markeru po kompakcji kończy się `missing-selection`. Stan (2026-09-12): `passed` dla 2.1.268. A dd-verified generator proof for the pinned binary records four byte-exact sites, and `judgeM1` re-reads all four against that binary on every run, so a pass needs the proof to still describe the binary plus a collision-free sample of at least two ids matching `^a[0-9a-f]{16}$` from a generator drawing at least 64 bits (run `compaction-sbnVo0`, 4 of 4 sites verified; shifting one offset by a byte returns `pending` with `m1-proof-site-mismatch`). `pending` dla 2.1.267, which has no proof on purpose because its compaction-continuity clause is unmeasured. `status` stays `pending`, so channel C stays closed in production. |
| M2 | Czy parametr `model` wywołania Agent przyjmuje pełny identyfikator mimo schematu z aliasami? | Wywołanie z pełnym identyfikatorem i obserwacja `clientModel` w requeście. | Request niesie podany identyfikator. | `clientModel` w katalogu ograniczony do aliasów. Stan (2026-09-11): `failed` dla 2.1.268. The client rejects a full id in the call parameter with a local `InputValidationError` (enum of four aliases) and spawns no child; an alias in the same parameter does override frontmatter (runs `delegate-8EiyAy`, `delegate-IiHhdB`, control `delegate-J6ctNL`). The negative-result effect applies: native per-child selection is limited to alias classes. |
| M3 | Gdzie ląduje `additionalContext` z `SubagentStart` w requeście dziecka i czy request niesie zgodny `x-claude-code-agent-id`? | Hook wstrzykuje marker testowy z tokenem, brama zapisuje body oraz nagłówek identyfikatora agenta. | Marker w bloku `system` albo w pierwszej linii pierwszej wiadomości `user`; obecny nagłówek jest zgodny z `agent_id` markera. | Kanał B zastąpiony kanałem B2 z rejestracją `agent_id` w handlerze, ale B2 może działać wyłącznie po zaliczeniu podprzypadku M3-B2, M1, M10-freshness i przy `correlation: "auto"`. |
| M3-A | Czy w pierwszej wiadomości `user` dziecka marker rodzica z pierwszej linii promptu delegacji ląduje w ostatnim bloku tekstowym za rozpoznawalnym prefiksem natywnym (v1: scaffold w bloku 0, marker w bloku 1; v2: instrukcje w bloku 0, scaffold w bloku 1, marker w bloku 2) i czy handler z profilem `after-native-context-v1` albo `after-native-context-v2` związanym z dokładną wersją klienta routuje dziecko na model wskazany aliasem? | Rzeczywisty klient w izolowanym środowisku deleguje do dwóch agentów `model: inherit` z różnymi markerami przez produkcyjny handler do pętli zwrotnej; brama zapisuje request przed handlerem i request upstream. | Oba dzieci otrzymują upstream request z modelem odpowiadającym aliasowi, blok 0 jest przekazany bez zmian, marker usunięty z bloku 1, a rodzic dekoduje oba echa modeli w `tool_result`. Wersja z requestu równa wersji profilu. | Pole `parentPromptPosition` pozostaje nieustawione dla tej wersji; kanał A działa tylko w pozycji legacy, a zmierzony układ kończy się `missing-selection`. Stan (2026-09-11): `passed` dla 2.1.268 w układzie v2 (przebieg `handler-yXSP4o`) i `passed` dla 2.1.267, `pending` dla 2.1.266. The clause that no fixture declares `parentPromptPosition` is historical: `claude-code-2.1.268.json` now declares `after-native-context-v2`, while `status`, `M10` and the unmeasured lifecycle phases still keep the path closed in production. |
| M4 | Czy fork niesie `cc_is_subagent=true` i czy `SubagentStart` uruchamia się dla forka? | Fork z hookiem i bramą zapisującą body. | Oba warunki spełnione. | Nierozpoznany fork pozostaje pass-through; fork z rozpoznanym pochodzeniem podlega wymaganiu 19. Kryterium 6 zostaje w drugim etapie. |
| M5 | Czy Codex z własnym `model_providers` bez `model_catalog` akceptuje nieznany identyfikator modelu w `spawn_agent`? | Spawn z opaque identyfikatorem przeciw bramie zapisującej body. | Request dziecka niesie identyfikator bez zmian. | Generator działa z `harness.codex.emitModelCatalog: true` i wytwarza katalog z allowlist. |
| M6 | Czy wariant agenta OpenCode dziedziczy prompt, narzędzia i uprawnienia bazowego agenta, czy model spoza `models` providera jest odrzucany, czy model wariantu jest zachowany po wznowieniu oraz czy podprzypadek M6-runtime skutecznie odmawia przed dzieckiem? | Porównanie rozwiązanej konfiguracji wariantu i bazy, spawn z modelem spoza providera, test wznowienia z bramą oraz zarejestrowany `tool.execute.before`. M6-runtime obejmuje każdą drogę deklarowaną jako wspierana: Task, direct, manual, nested i resume. Przed spawn guard odczytuje authoritative effective config lub definition i porównuje ją z read-only metadata sidecar, jego `snapshotGeneration` i hashem artefaktu. Negatywna kontrola podaje niedozwolony provider lub model i musi zatrzymać dziecko przed requestem upstream; pozytywna kontrola podaje dozwolony `PROVIDER_ID/upstreamModel` i musi uruchomić dziecko z configured provider oraz rzeczywiście odebranym exact `upstreamModel`. | Różnica tylko w `model`, `name`, `description`, `hidden`; model spoza providera odrzucony; model po wznowieniu bez zmian; guard odmawia skutecznie przed dzieckiem po odczycie authoritative effective config zgodnym z metadata sidecar, a pozytywna kontrola przechodzi dla każdej wspieranej drogi z configured provider i exact modelem. | Generator kopiuje brakujące pola jawnie albo adapter odmawia. Brak ścieżki, brak dowodu albo nieskuteczna odmowa oznacza `unsupported-path` dla tej drogi, nie założone wsparcie. |
| M7 | Czy zarejestrowany hook `PreToolUse` z matcherem `Agent` w wydanym Codex otrzymuje `model`, ma rzeczywisty oczekiwany kształt stdin i stdout oraz respektuje `deny`? | Wydany Codex uruchamia zarejestrowany hook, który przetwarza raw stdin i stdout wyłącznie ulotnie, raportuje tylko allowlist pól, wynik walidacji modelu i decyzję bez body, promptu lub tokenu, przed spawn odczytuje authoritative effective config lub definition zgodną z read-only metadata sidecar, jego `snapshotGeneration` i hashem artefaktu oraz odrzuca niedozwolony model; brama kontrolna sprawdza brak requestu dziecka. | Wywołanie odrzucone przez działający hook bez uruchomienia dziecka i bez requestu upstream. Czysta funkcja lub plik bez rejestracji nie zalicza pomiaru. | Adapter Codex odmawia działania dla tej wersji z kodem `unsupported-path`. |
| M9 | Jaka jest precedencja między jawnym `model` w `spawn_agent` a modelem roli w wydanym Codex? | Rola z modelem B, spawn tej roli z jawnym modelem C, brama zapisuje model dziecka. | Brama odbiera C i rezultat odpowiada decyzji core. | Adapter zgłasza tę ścieżkę jako `unsupported-path`; przed wynikiem M9 pozostaje ona `pending`, nie jest certyfikowanym wsparciem. |
| M10 | Czy `upstreamModel` dziecka jest stały przez każde wspierane przejście lifecycle w każdym harnessie: kolejne tury, wznowienie, kompakcja, dziecko zagnieżdżone, dziecko równoległe, oraz czy podprzypadek M10-freshness rozpoznaje świeżą delegację przed pierwszym requestem? | Dla każdego harnessu scenariusz z bramą zapisującą model każdego requestu i identyfikator dziecka. M10-freshness rejestruje wiarygodne zdarzenie harnessu nowej delegacji oraz porównuje je z resume, compaction, TTL i restartem handlera. Sama długość historii, brak `compact_boundary` albo obecność requestu nie są sygnałem pozytywnym. | Każdy request danego dziecka niesie ten sam `upstreamModel`; dzieci różnią się między sobą; rodzic bez zmian. M10-freshness przed pierwszym requestem rozróżnia nową delegację od każdego scenariusza odtworzenia stanu. | Niezaliczone przejście jest oznaczone jako niewspierane w dokumentacji adaptera, a adapter zgłasza je jako `unsupported-path`, gdy potrafi je wykryć. Brak M10-freshness wyłącza inicjalizację defaultu bez jawnego wyboru lub korelacji zgodnie z wymaganiem 19. Stan (2026-09-12): `compaction` jest `passed` dla 2.1.268, measured on the real profile with no correlation scaffold (run `compaction-3slJXF`, `correlationScaffold: false`): both children compacted three times each, every post-compaction request was forwarded on the child's own upstream model, nothing was refused. The compacted history drops the marker, so the agent-id correlation binding is what carries the child; the earlier marker-only run `compaction-sbnVo0` measured `failed` and stays the record of what the marker-only path does. `resume` stays `pending` for 2.1.268 (the client issues a fresh child id on re-delegation), and `M10` itself plus `M10-freshness` stay `pending`, so this is not a support promotion. |

Faza lifecycle może pochodzić wyłącznie z potwierdzonego kontekstu natywnego harnessu, nie z argumentów narzędzia podanych przez model. Gdy adapter jej nie rozpoznaje, nie zakłada `next-turn`: dopuszczenie tej drogi wymaga zaliczenia wszystkich przejść M10, które mogą nią nadejść. Gdy umie wiarygodnie rozpoznać fazę, może dopuścić tylko zaliczone przejście i odmówić pozostałych. Osobne ograniczenie forka z D3 i M4 pozostaje bez zmian.

Pomiar informacyjny, poza bramką statusu:

| Id | Pytanie | Metoda | Wymagany artefakt |
|---|---|---|---|
| M8 | Jakie skutki ma rozjazd `clientModel` i `upstreamModel` dla limitów i reasoning? | Dziecko z aliasem `haiku` i modelem upstream o innym limicie, test długiego kontekstu. | Tabela par i obserwacji w dokumentacji bloku adaptera Claude Code. |

Diagnostyka MOŻE zawierać nazwę adaptera, identyfikator korelacyjny, wybrany identyfikator modelu, `clientModel`, źródło decyzji, kod decyzji i listę zignorowanych markerów bez ich treści. NIE MOŻE zawierać promptów, wyników narzędzi, treści odpowiedzi, sekretu tokenu ani wartości nagłówków autoryzacji.

Pomiary M1 do M7, M9 i M10 nadal pozostają niewykonane. Rewizja 3 dodaje kryteria katalogu, resolverów i CLI poniżej; ich dopisanie nie jest dowodem działania. Wersję klienta można oznaczyć jako wspieraną dopiero po zaliczeniu scenariuszy odpowiedniego adaptera.

## Alternatywy i decyzje

### Własny agent loop

Odrzucone. Dublowałoby natywne narzędzia, uprawnienia, UI i lifecycle, które projekt ma zachować.

### Wybór tylko przez natywne pole modelu

Odrzucone dla Claude Code. Pole nie przyjmuje dowolnych identyfikatorów bramy, hooki nie mogą go zmienić, a fork je ignoruje. Przyjęte dla OpenCode i Codex jako tryb `native`, bo resolved native model component jest tam dokładnie `upstreamModel` zgodnie z wymaganiem 31.

### Hook PreToolUse podmieniający model w Claude Code

Odrzucone. Dokumentacja wyklucza `updatedInput` dla narzędzia Agent.

### Aliasy środowiskowe `ANTHROPIC_DEFAULT_*_MODEL` jako jedyny mechanizm

Odrzucone jako jedyny mechanizm. Dają kilka klas modeli, nie dowolną liczbę modeli dzieci. Mogą uzupełniać `clientModel` w katalogu.

### Opcjonalny proxy po wdrożeniu

Odrzucone. Routing przed bramą jest częścią zakresu dla trybu `marker-routed`, a embed musi użyć handlera bez dodatkowego procesu.

### Marker akceptowany w dowolnym miejscu promptu albo bloku system

Odrzucone. Treść `CLAUDE.md`, pliki czytane przez narzędzia i cytaty trafiają do tych samych bloków. Bez związania z pozycją początku promptu albo z tokenem adaptera marker nie ma wiarygodnego pochodzenia.

### Trwała pamięć korelacji na dysku

Odrzucone. Wymaganie 7 wyklucza bazę danych. Ulotna mapa procesu z limitem czasu wystarcza, bo kanał A odtwarza decyzję z promptu delegacji.

### Plugin OpenCode podmieniający `subagent_type`

Odrzucone. Ukryta podmiana odbiera rodzicowi jawny wybór i utrudnia diagnozę. Warianty agentów są widoczne w konfiguracji.

### Routing po nazwie dostawcy

Odrzucone. Model identifiers pozostają opaque, a auth i protokoły dostawców należą do zewnętrznej bramy.

### Klasyfikator LLM dla przydziału modeli

Odrzucone. Wprowadza niedeterministyczną decyzję i dodatkowy koszt. Wybór ma wynikać z jawnej delegacji, roli i konfiguracji.

### Cichy fallback do modelu rodzica

Odrzucone. Ukrywa błąd i łamie intencję jawnego routingu dziecka.

### Drop-in zgodność z CCR

Nie jest wymagana. CCR jest inspiracją dla wzorca marker plus routing, nie publicznym kontraktem składni markeru.

### Osadzenie bramy `@the-next-ai/ai-gateway` w routerze

Odrzucone. Główny powód jest wydajnościowy: operator obserwuje wyraźnie wolniejszą obsługę dostawcy OpenAI przez ten pakiet w CCR. [assumption] Nie ma pomiaru w tym projekcie; nie ustalono, czy przyczyną jest sam pakiet, jego konfiguracja czy warstwa sieciowa. Wybór bramy jest więc decyzją operacyjną, a nie wnioskiem z benchmarku.

Powód drugi jest architektoniczny. CCR używa tego pakietu jako własnej bramy. Router pozostaje cienką warstwą przed zewnętrzną bramą, docelowo `9router` lub OmniRoute. Zależność od pakietu bramy związałaby router z jej protokołami, auth, wydajnością i cyklem wydań oraz naruszyłaby wymagania 45, 46 i 47.

Konsekwencja projektowa: skoro router nie decyduje o wydajności rozmowy z dostawcą, wymiana bramy na szybszą MUSI być zmianą konfiguracji endpointu, bez gałęzi kodu routera. To jest już wymaganie 47 i jego test `e2e::opaque-identifiers-survive-gateway-endpoint-swap`.

### Obowiązkowe discovery lub pobranie w czasie requestu

Odrzucone. Discovery jest jawną komendą operatora i nie jest provider integration. Core oraz preview używają tylko istniejącego snapshotu offline.

### Generowanie lub podmiana natywnych agentów

Odrzucone. Natywne definicje są read-only źródłem ról. Eksport jest oddzielnym artefaktem do ręcznej integracji i nie odtwarza brakującej definicji.

### Hot reload katalogu i scheduler synchronizacji

Odrzucone. Aktywny handler używa snapshotu z chwili startu. Zmiana katalogu wymaga jawnego sync i nowej instancji.

## Kryteria akceptacji

Następujące kryteria są wymaganiami przyszłego wdrożenia. Nie są obecnie spełnione ani przetestowane.

1. Parent używa modelu A, a równoczesne dzieci używają modeli B i C. Kontrolowana brama potwierdza rzeczywiście odebrane `upstreamModel` dla każdego requestu. Kryterium obowiązuje osobno dla każdego z trzech harnessów.
2. Test używa dowolnych opaque identifiers i po zmianie endpointu bramy nie dodaje gałęzi routingu po vendorze.
3. Dziecko wywołuje narzędzie, otrzymuje jego wynik i natywny klient zwraca poprawnie zdekodowaną odpowiedź końcową. Handler nie dekoduje ani nie regeneruje odpowiedzi. Deklaracja modelu o własnej nazwie nie jest dowodem właściwego routingu.
4. Parent pozostaje niezmieniony względem baseline po dozwolonym, stałym wzbogaceniu D9 opisów `Agent`, `Task`, `Workflow` i opisu promptu. Cytowany marker w historii, wyniku narzędzia, odpowiedzi asystenta, dalszej części promptu delegacji albo bloku `system` bez poprawnego tokenu, na przykład przemycony przez `CLAUDE.md`, nie zmienia niczego względem tego baseline. Dziecko z takim markerem poza autoryzowaną pozycją jest obsługiwane tak, jakby markeru nie było, z kodem `ignored-marker`.
5. Zagnieżdżone dzieci i niezależne równoległe sesje nie mają wycieku decyzji ani stanu. Dwa dzieci z różnymi identyfikatorami i różnymi markerami otrzymują różne `upstreamModel` w tym samym procesie handlera. Wymuszona kolizja identyfikatora z odmiennym markerem kończy się `correlation-conflict`, a nie decyzją pierwszego dziecka.
6. Fork z odziedziczonym `clientModel` i odmiennym `upstreamModel` jest sprawdzony osobno przez kontrolowaną bramę. Kryterium drugiego etapu, zależne od M4.
7. Dla wspieranej wersji klienta wieloturowa praca dziecka, resume i compaction zachowują jego wybór modelu, potwierdzony przez pomiar M10 dla każdego harnessu. M10-freshness osobno rozróżnia nową delegację od resume, compaction, TTL i restartu przed inicjalizacją defaultu. Oddzielne testy utraty informacji o trasie wymagają zachowania według wymagania 19. Sam błąd `unsupported-path` nie zalicza scenariusza działającej integracji.
8. Nieznany, niejednoznaczny albo niedozwolony target rozpoznanego dziecka objętego routingiem powoduje błąd bez wywołania bramy. Obcy lub cytowany marker rodzica, również z nieznanym modelem, nie uruchamia tej walidacji i nie blokuje jego requestu.
9. Cancellation, disconnect i stream backpressure przechodzą przez handler bez zmiany semantyki. Fake gateway potwierdza identyczne bajty odpowiedzi, status, nagłówki end-to-end oraz SSE, w tym nieznane ramki, błędy, tool i usage, bez dekodowania, regenerowania lub pełnego buforowania przez handler.
10. Core buduje i działa w środowisku bez zależności Bun-only.
11. Testy fake gateway są hermetyczne i stanowią pierwszą linię walidacji.
12. Opt-in testy realnych harnessów działają przeciw zewnętrznej bramie, nie przechowują sekretów i raportują wersje harnessów.
13. Walidator konfiguracji odrzuca plik z nieznaną wersją, nieznanym polem albo wartością nagłówka podaną inline.
14. `config export` nie zmienia żadnego pliku natywnego. Suma SHA-256 natywnych plików agentów przed i po eksporcie jest identyczna, a istniejąca deklaracja `inherit` pozostaje bez zmian.
15. Fake endpoint modeli ma pozytywną kontrolę z poprawnym `data[].id`, a osobne scenariusze odrzucają zły schema, auth failure, malformed JSON, duplikaty, nieobsługiwaną niepełną paginację, przekroczony limit i nieoczekiwanie pusty katalog bez `--allow-empty`.
16. Nieudany sync zachowuje hash poprzedniego `models.lock.json`. Poprawny sync zapisuje cały nowy snapshot atomowo i pokazuje `added`, `changed`, `missing`.
17. Lokalny opis, alias i routing roli przetrwają zniknięcie oraz ponowne pojawienie się ID. Zniknięty, wyłączony albo nieobecny ID nie routuje i nie korzysta z fallbacku.
18. Fixture obejmuje upstream IDs ze spacjami, Unicode i różnicą wielkości liter. Alias mapuje do dokładnego ID, kolizja aliasów jest błędem, a marker nie przenosi surowego ID.
19. Fixture resolvera obejmuje kolizje scope, effective naming inne niż nazwa pliku, `inherit`, shadowed entries i role fileless. Pusty skan katalogu nie usuwa roli ujawnionej przez native tool schema.
20. `route preview` nie wykonuje sieci, nie uruchamia narzędzi ani agenta i pokazuje symulację z aliasem, actual `upstreamModel`, `clientModel` albo `unknown`. Nie składa twierdzenia o bieżącym runtime.
21. Wszystkie komendy inspekcji obsługują `--json`, domyślnie działają offline, nie wypisują sekretów i zwracają właściwe exit codes. Sieciowy `doctor --connect` jest testowany jako jawny wyjątek bez zapisu. Brak koloru przy non-TTY jest testowany.
22. Równoczesne edycje `subagent-router.json` przez `models describe` są wykrywane i druga edycja jest odrzucona bez nadpisania pierwszej.
23. Dodanie lokalnego opisu do modelu ze snapshotu nie definiuje modelu ręcznie, a istniejące opisy narzędzi rodzica są zachowane po idempotentnym dodaniu katalogu. Porównanie używa baseline po dozwolonym, stałym wzbogaceniu D9 i potwierdza brak zmiany pozostałych schema fields, narzędzi, uprawnień, bloków `system` oraz historii.
24. Zmiana endpointu przy tym samym `sourceId` odrzuca stary snapshot. Sync z `--dry-run` nie zmienia hashów configu ani snapshotu. Cykl kursora, sprzeczna paginacja i redirect między originami nie zapisują częściowego katalogu.
25. Zmiana aliasu zachowuje przypisania ról zapisane jako ID. `hidden` nie jest mylone z brakującą rolą, a symlink prowadzący z katalogu eksportu do natywnego configu jest odrzucany także z `--force`.
26. Wynik preview podaje generację wczytanych plików. Nie przedstawia jej jako generacji działającego procesu, który nadal używa konfiguracji ze swojego startu.

## Strategia testów

[assumption] Warstwy testów powinny oddzielać deterministyczny core, HTTP handler i adaptery harnessów.

- Testy core sprawdzają katalog, priorytet decyzji, allowlist, konflikty markerów, brak fallbacku, izolację sesji i kody decyzji.
- Testy handlera z fake gateway przechwytują request, `upstreamModel`, body bez markera, anulowanie, backpressure oraz zachowanie mapy korelacji po limicie czasu.
- Offline testy eksportu porównują artefakty i metadata sidecar z oczekiwanym wynikiem, odrzucają katalog źródłowy i kolizję wyjścia oraz porównują SHA-256 natywnych definicji przed i po operacji. Nie deklarują, że native harness załadował artefakt.
- Testy discovery używają fake endpointu z pozytywną kontrolą i fixtures błędów schema, auth, paginacji, limitu i pustego katalogu. Testy potwierdzają atomowość snapshotu oraz zachowanie hash poprzedniej wersji po błędzie.
- Testy CLI obejmują tryb offline, `--json`, stderr bez sekretów, exit codes, non-TTY, konflikty współbieżnej edycji i preview bez sieci lub narzędzi.
- Testy resolverów sprawdzają effective name, scope, shadowing, `inherit`, aliasy oraz role fileless dostarczone przez native schema.
- Testy adaptera potwierdzają przekazanie wiarygodnego kontekstu dziecka, idempotentne zachowanie istniejących opisów narzędzi oraz jawny błąd na nieobsługiwanej ścieżce.
- Testy E2E adapterów, nie offline testy eksportu, potwierdzają że harness odczytał authoritative effective definition lub konfigurację przed spawn oraz zgodność z metadata sidecar, `snapshotGeneration` i hashem artefaktu.
- Testy E2E są opt-in, nie zapisują sekretów, raportują wersję harnessu oraz bramy i realizują pomiary M1 do M7, M9 i M10 jako osobne, nazwane scenariusze bramkujące. M6 zawiera podprzypadek M6-runtime dla negatywnej i pozytywnej kontroli guardu OpenCode, a M10 zawiera M10-freshness dla sygnału nowej delegacji. Pomiar M8 jest osobnym scenariuszem informacyjnym, którego wynik trafia do dokumentacji bloku.

### Asercje strategii testów

- Testy core sprawdzają, że alias i opis nie zmieniają exact, case-sensitive `upstreamModel`, a jawny wybór oraz już uprawniony przez M10-freshness default roli lub globalny default dają dokładnie jeden wynik według wymagania 18.
- Testy D2 sprawdzają, że adapterowy marker w pozycji `user` jest `ignored-marker`, dopóki M3 nie potwierdzi tej dokładnej pozycji i tokenu. Testy slotu `after-native-context-v1` sprawdzają osobno: zmierzony układ, brak `M3-A`, brak jawnego ustawienia, niezgodną lub brakującą wersję klienta, zniekształcony scaffold, dodatkowe bloki, marker dalej w bloku 1, marker wewnątrz bloku 0 oraz podpisany marker adaptera w tym slocie; pozycja legacy pozostaje zielona bez zmian. Testy slotu `after-native-context-v2` sprawdzają to samo dla układu trzyblokowego, a dodatkowo rozłączność układów: profil v1 nie przyjmuje wiadomości trzyblokowej, profil v2 nie przyjmuje dwublokowej, a przebieg oceniony regułami drugiego układu kończy się `pending`, nigdy `passed`. Każde użycie B wymaga zgodnego `agent_id` z nagłówkiem. Kanał B2 wymaga wyniku M1, `correlation: "auto"`, potwierdzonego pochodzenia każdego requestu i nie może ominąć guardu kanału C.
- Testy korelacji sprawdzają, że związana decyzja trwa po utracie markera przy zachowanej tożsamości, konflikt kończy się błędem, a po restarcie bez markera i stanu tożsamości nie powstaje nowy default. M10-freshness odróżnia nową delegację od resume, compaction, TTL i restartu, bez użycia długości historii lub braku `compact_boundary` jako dowodu. Testują osobno jawny opt-in `inherit`.
- Testy `native` uruchamiają rzeczywisty punkt runtime przed dzieckiem. Negatywna kontrola obserwuje odmowę i brak requestu upstream, a pozytywna obserwuje uruchomione dziecko z modelem równym decyzji core. Ścieżka bez obu dowodów jest `unsupported-path`.
- Testy OpenCode obejmują każdą drogę zadeklarowaną jako wspierana, Task, direct, manual, nested i resume, bez modyfikacji `args` lub `subagent_type`. Testy Codex potwierdzają rejestrację `PreToolUse`, rzeczywiste stdin/stdout, `deny`, native precedence i M9 przed certyfikacją ścieżki z rolą.
- Offline testy eksportu sprawdzają metadata sidecar, `snapshotGeneration` i hash artefaktu, lecz nie twierdzą, że harness coś załadował. E2E adaptera sprawdza authoritative effective definition lub konfigurację przed spawn. Sam artefakt eksportu, niezastosowany default lub nieweryfikowalna konfiguracja nie są sukcesem.
- Testy handlera porównują bajtowo odpowiedź i ramki streamu oraz sprawdzają status, nagłówki end-to-end, nieznane SSE, błędy, tool, usage, abort, disconnect i backpressure. Sprawdzają także brak pełnego buforowania, dekodowania, regenerowania, retry, fallbacku i dodatkowego generatywnego call.
- Testy granic sprawdzają, że core i handler nie importują obowiązkowego AI SDK, nie uruchamiają MCP lub KB i nie zawierają vendor branch. Test granic sprawdza też, że `package.json` nie zawiera zależności `@the-next-ai/ai-gateway` w żadnej sekcji, a `src` nie importuje modułu o tej nazwie. Mock bramy, `9router`, OmniRoute lub LiteLLM pozostają wymiennymi endpointami poza routerem.

Sukces E2E wymaga zarówno capture z kontrolowanej bramy, jak i znaczącego, zdekodowanego przez natywnego klienta roundtripu narzędzia dziecka oraz wyniku końcowego. Sam tekst odpowiedzi modelu nie wystarcza.

## Related

- [Indeks dokumentacji](../../README.md)
- [Konwencje dokumentacji](../../CONVENTIONS.md)
- [Plan wdrożenia routingu modeli](../plans/2026-09-06-subagent-model-routing.md)
- [CCR, pinned commit `c49733678660f726540fca3fff20bbd7d6cab032`](https://github.com/kolezka/claude-code-router/tree/c49733678660f726540fca3fff20bbd7d6cab032)
- [Claude Code sub-agents documentation](https://code.claude.com/docs/en/sub-agents)
- [Claude Code hooks documentation](https://code.claude.com/docs/en/hooks)
- [OpenCode, pinned commit `337fd144d2ba144743368f78d9579a99cce175bd`](https://github.com/anomalyco/opencode/tree/337fd144d2ba144743368f78d9579a99cce175bd)
- [OpenCode agents documentation](https://opencode.ai/docs/agents/)
- [Codex, pinned commit `ac192cd7937b0d73edc6dffe009940ae53782dd4`](https://github.com/openai/codex/tree/ac192cd7937b0d73edc6dffe009940ae53782dd4)
- [Codex hooks documentation](https://learn.chatgpt.com/docs/hooks)
- [Codex subagents documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents)
