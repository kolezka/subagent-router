# Routing modeli subagentów

Date: 2026-09-06

Status: draft (rewizja 2, luki rozstrzygnięte, do przeglądu)

## Cel

`subagent-router` ma umożliwić rodzicowi świadomy wybór modelu dla konkretnego natywnego subagenta bez zmiany modelu rodzica. Jedno uruchomienie może jednocześnie obsługiwać dzieci używające różnych modeli i różnych dostawców, o ile skonfigurowana brama je obsługuje.

Projekt ma być małym pakietem Bun + TypeScript. Ma działać jako biblioteka importowana przez inne narzędzia oraz samodzielnie przez CLI. Jest to jeden pakiet, nie monorepo.

Dokument opisuje proponowany projekt. Status `draft` nie oznacza akceptacji wszystkich szczegółów ani zgody na rozpoczęcie implementacji. Rewizja 2 zamyka otwarte decyzje projektowe z rewizji 1 i zamienia pozostałe luki na konkretne pomiary z kryteriami.

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

1. Pakiet MUSI być pojedynczym pakietem Bun + TypeScript, bez monorepo.
2. Core MUSI być czysty i importowalny bez obowiązkowego procesu serwera.
3. Core NIE MOŻE zależeć od SDK harnessów.
4. Bun jest dozwolony w CLI i trybie standalone, ale core NIE MOŻE wymagać API specyficznego dla Bun.
5. CLI MOŻE wystawić jawny config, hook entry, generator konfiguracji harnessu i `serve`.
6. CLI NIE MOŻE automatycznie modyfikować istniejących globalnych ustawień użytkownika. Generator zapisuje tylko do wskazanej ścieżki i nie nadpisuje istniejących plików bez jawnej flagi.
7. Projekt NIE MOŻE tworzyć własnego agent loop, MCP runner, schedulera, UI ani bazy danych.
8. Projekt NIE OBEJMUJE auth kont dostawców, protocol translation, obowiązkowego provider discovery ani automatycznego fallbacku do innego modelu.

### Wybór modelu

9. Rodzic MUSI móc wybrać model dla konkretnego dziecka z katalogu opisów modeli.
10. Core MUSI walidować każdy jawny wybór względem katalogu allowlist.
11. Core MOŻE stosować jawne modele domyślne ról.
12. Core NIE MOŻE uruchamiać dodatkowego LLM do klasyfikacji zadania albo wyboru modelu.
13. Różne dzieci MUSZĄ móc używać różnych modeli i dostawców w tej samej sesji.
14. Wybór dziecka NIE MOŻE zmieniać modelu rodzica.
15. Identyfikator modelu upstream MUSI być opaque. Pakiet NIE MOŻE rozgałęziać logiki po nazwie vendora ani definiować `providers/*`.
16. Katalog allowlist NIE MOŻE być nadpisany tekstem promptu, historią, rezultatem narzędzia ani cytatem.
17. Skonfigurowana rola sama w sobie NIE JEST dowodem, że dowolny request pochodzi od dziecka.

### Deterministyczne reguły decyzji

18. Dla dziecka objętego routingiem kolejność decyzji MUSI być następująca: jawny wybór, model domyślny konkretnej roli, globalny model domyślny dzieci. Niepoprawny jawny wybór NIE MOŻE przejść do wartości domyślnej.
19. Dziecko jest objęte routingiem, gdy adapter potwierdził jego pochodzenie i istnieje dla niego jawny wybór, rola z modelem domyślnym, globalny model domyślny dzieci albo wcześniejsza decyzja skorelowana z tym samym dzieckiem. Niepoprawny marker w autoryzowanej pozycji jest błędem `invalid-marker`, nie brakiem markeru. Dziecko rozpoznane bez żadnego wskazania kończy się błędem `missing-selection`, bo router nie potrafi odróżnić dziecka nigdy nieobjętego routingiem od dziecka, które utraciło trasę po kompakcji albo restarcie handlera. Jedynym wyjątkiem jest jawny opt-in `defaults.unmarkedSubagent: "inherit"`, który przepuszcza takie dziecko z kodem `inherit-allowed`. Ten opt-in jest świadomą zgodą operatora na to, że utrata trasy będzie niewidoczna, i jest opisany w konfiguracji jako taka zgoda.
20. Parent bez dopasowania MUSI przejść pass-through.
21. Jawnie routowane child z nieznanym modelem, modelem niedozwolonym, sprzecznymi markerami albo nieobsługiwaną ścieżką MUSI zakończyć się błędem.
22. W takich przypadkach NIE WOLNO cicho użyć modelu rodzica.
23. Pakiet NIE MOŻE automatycznie wybrać innego modelu po błędzie routingu.

### Model klienta i model upstream

24. Dokumentacja i kontrakty MUSZĄ rozróżniać `clientModel` od `upstreamModel`.
25. `clientModel` to ustawienie używane do walidacji, inicjalizacji harnessu i, gdzie obsługiwane, limitów właściwych dla klienta.
26. `upstreamModel` to model realnie wysyłany do skonfigurowanej bramy.
27. Natywny fork MOŻE odziedziczyć `clientModel`, a routing requestu MOŻE wybrać odmienny `upstreamModel`.
28. W trybie `marker-routed` wybór rzeczywistego modelu NIE MOŻE zależeć wyłącznie od natywnego pola modelu harnessu. W trybie `native` natywne pole jest z definicji `upstreamModel`, a wymaganie 33 opisuje obowiązkową walidację.
29. Przypadek fork z odziedziczonym `clientModel` i innym `upstreamModel` MUSI mieć osobny przypadek akceptacyjny.
30. Specyfikacja NIE twierdzi, że różne fork są już przetestowane.

### Tryby integracji

31. Każdy adapter MUSI deklarować jeden z dwóch trybów: `native`, gdy natywne pole modelu harnessu jest dosłownie `upstreamModel`, albo `marker-routed`, gdy `upstreamModel` ustala handler przed bramą.
32. OpenCode i Codex działają w trybie `native`. Claude Code działa w trybie `marker-routed`. Zmiana trybu adaptera wymaga rewizji specyfikacji.
33. W trybie `native` core nadal waliduje wybór względem allowlist i rozstrzyga defaulty, ale handler HTTP nie jest wymagany. Walidacja jawnego pola modelu MUSI działać w czasie wykonania, przed uruchomieniem dziecka. Jeżeli harness w danej wersji nie daje skutecznego punktu zaczepienia, adapter MUSI odmówić działania dla tej wersji z kodem `unsupported-path`. Deklaratywne ograniczenie do ról nie zastępuje walidacji runtime, bo nie zatrzymuje bezpośredniego podania modelu przez rodzica.

### Routing przed bramą

34. Warstwa routingu przed bramą jest częścią zakresu pierwszej implementacji dla trybu `marker-routed`.
35. Core, client adapters oraz cienki HTTP handler lub CLI `serve` MUSZĄ wspólnie zapewnić routing markerów dla Claude Code.
36. Aplikacja embed MUSI móc użyć tego samego handlera bez uruchamiania dodatkowego procesu proxy.
37. Handler MUSI wysyłać routing upstream do bramy skonfigurowanej przez caller lub środowisko.
38. Handler NIE MOŻE wyprowadzać URL upstream z promptu ani z request content.
39. Konfiguracja endpointu forwarding i nagłówków MUSI pochodzić od caller lub środowiska.
40. Sekrety NIE MOGĄ trafiać do promptów, markerów ani diagnostyki.
41. Handler MOŻE czytać routing JSON tylko dla obsługiwanych requestów.
42. Odpowiedzi i stream MUSZĄ być pass-through. Pakiet NIE MOŻE wykonywać protocol translation.
43. Anulowanie i backpressure streamu MUSZĄ przejść do upstream bez semantycznej zmiany.

### Niezależność od bramy

44. `9router` i `omnirouter` są zewnętrzną warstwą protokołów, auth do dostawców i obsługi dostawców.
45. `subagent-router` MUSI być niezależny od obu tych projektów.
46. Pakiet NIE MOŻE zawierać adapterów bram, implementacji auth dostawców ani routingu po vendorze.
47. Wymiana endpointu bramy przy tych samych opaque model identifiers NIE MOŻE wymagać gałęzi kodu routera.

## Architektura i odpowiedzialności

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
- auth,
- translację protokołu,
- wykrywanie możliwości dostawcy,
- zarządzanie lifecycle subagenta.

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

[assumption] Cienki handler rozpoznaje kontrolowany marker bieżącego dziecka, wylicza decyzję core, usuwa marker wyłącznie z kopii requestu wysyłanej upstream i przekazuje request do skonfigurowanej bramy.

Oryginalna historia klienta NIE MOŻE być mutowana. Handler NIE MOŻE uznać za upoważniony dowolnego markera odnalezionego w dawnej historii, tool results lub cytowanym tekście.

Handler utrzymuje wyłącznie ulotną pamięć korelacji opisaną w sekcji o kanałach routingu. Nie zapisuje niczego na dysk.

### Konfiguracja

Konfiguracja jest jednym plikiem JSON z polem `version`. Core przyjmuje ten sam kształt jako zwykły obiekt, więc aplikacja embed nie musi używać pliku. Format opisano w sekcji „Decyzja D4”.

Konfiguracja MUSI rozdzielać:

- `clientModel`, gdy adapter go potrzebuje,
- `upstreamModel`, gdy handler routuje request,
- role i ich defaulty,
- allowlist modeli,
- endpoint i nagłówki przekazywane przez caller lub środowisko.

## Kontrakty i invariants

`enforcement: brak implementacji`. Poniższe kontrakty opisują wymagania, nie istniejące zabezpieczenia. Docelowo decyzję i allowlist sprawdzają testy core, pochodzenie i ciągłość wyboru testy adapterów, a rzeczywisty model oraz transport testy handlera i E2E.

### Kontrakt decyzji routingu

Dla każdego obsługiwanego requestu core zwraca dokładnie jeden wynik:

1. `pass-through` dla rodzica albo dla dziecka objętego jawnym opt-in dziedziczenia. Wynik niesie kod diagnostyczny `parent` albo `inherit-allowed` oraz listę zignorowanych markerów z pozycji nieautoryzowanych jako `ignored-marker`.
2. `route` z jednym zwalidowanym opaque `upstreamModel` dla rozpoznanego dziecka. Wynik niesie źródło decyzji: `explicit`, `role-default`, `global-default`, `correlated`.
3. `error` dla dziecka objętego routingiem, gdy wybór jest niepoprawny, brakujący albo nieobsługiwany. Wynik niesie kod błędu: `unknown-model`, `model-not-allowed`, `invalid-marker`, `conflicting-markers`, `correlation-conflict`, `unsupported-path`, `missing-selection`.

Nie istnieje wynik znaczący „spróbuj modelu rodzica”.

### Invariant izolacji rodzica

Model rodzica, jego uprawnienia, narzędzia i lifecycle pozostają bez zmian. Zmiana dotyczy tylko requestu zakwalifikowanego jako konkretne dziecko.

### Invariant wiarygodnego pochodzenia

Marker jest sygnałem transportowym umieszczonym w autoryzowanej pozycji przez rodzica albo adapter dla bieżącego dziecka. Nie jest instrukcją tekstową dla modelu i nie może być zaakceptowany, gdy występuje tylko w nieautoryzowanej części danych requestu. Marker pochodzący od adaptera niesie token uwierzytelniający, marker pochodzący od rodzica jest związany z pozycją początku promptu delegacji. Autoryzowane pozycje wylicza sekcja „Decyzja D2”. Skutek każdego przyjętego markeru jest ograniczony do allowlist, więc najgorszy skutek nadużycia to wybór innego dozwolonego modelu, nigdy modelu spoza katalogu ani innej bramy.

### Invariant braku wycieku decyzji

Równoległe i zagnieżdżone dzieci, a także niezależne sesje, nie dzielą wyboru modelu. Anulowanie jednej sesji nie może zmienić decyzji drugiej. Pamięć korelacji jest kluczowana identyfikatorem konkretnego dziecka razem z identyfikatorem instancji handlera i nigdy nie jest dziedziczona przez inne dziecko. Kolizja identyfikatora z odmiennym markerem jest błędem `correlation-conflict`, nie cichym przejęciem decyzji.

### Invariant przejrzystej porażki

Dla dziecka objętego routingiem brak bezpiecznej trasy kończy obsługę błędem przed wywołaniem upstream. Nie powoduje zastąpienia modelu modelem rodzica. Zwykły ruch rodzica i dzieci nieobjętych routingiem pozostaje bez zmian.

### Invariant transportu

Po podjęciu decyzji handler usuwa marker z kopii requestu upstream. Poza wymaganymi zmianami routingu przekazuje body, odpowiedź, stream, anulowanie i backpressure bez translacji protokołu.

## Decyzje rozstrzygające luki rewizji 1

### Decyzja D1: dwa tryby integracji zamiast jednego mechanizmu dla wszystkich harnessów

Rozstrzyga lukę 6 i lukę 7 w części projektowej.

W OpenCode model agenta `provider/model` jest wysyłany do skonfigurowanego providera, a według odczytu źródła identyfikator musi istnieć w katalogu `models` tego providera, co potwierdza pomiar M6. W Codex model podany w `spawn_agent` albo w roli jest przekazywany jako ciąg do providera sesji. W obu przypadkach natywne pole modelu jest dosłownie `upstreamModel`, więc marker i handler nie są potrzebne. Bramą jest jeden skonfigurowany provider: dla OpenCode wpis providera OpenAI-compatible z `baseURL`, dla Codex `model_providers.<id>` z `base_url`.

W Claude Code natywne pole modelu jest ograniczone do aliasów albo identyfikatorów akceptowanych przez klienta, a hooki nie mogą zmienić modelu subagenta. Dlatego Claude Code wymaga trybu `marker-routed`: rodzic wybiera z katalogu, marker trafia do dziecka, handler przed bramą podmienia `upstreamModel`.

Konsekwencja: handler HTTP jest w pierwszej implementacji potrzebny tylko dla Claude Code. Core i konfiguracja są wspólne dla wszystkich trzech harnessów.

### Decyzja D2: kanały routingu i składnia markeru dla Claude Code

Rozstrzyga lukę 4 i lukę 9.

Marker ma postać jednego znacznika w jednej linii i występuje w dokładnie dwóch wariantach gramatyki:

```text
<subagent-router v="1" model="ID"/>
<subagent-router v="1" role="NAME" agent="AGENT_ID" token="HMAC"/>
```

Zasady:

- `v` to wersja składni. Nieznana wersja w autoryzowanej pozycji jest błędem `invalid-marker`.
- Wariant rodzica ma wyłącznie atrybuty `v` i `model`. `model` to opaque identyfikator z katalogu. Dozwolone znaki: litery, cyfry, `.`, `_`, `-`, `:`, `/`.
- Wariant adaptera ma wyłącznie atrybuty `v`, `role`, `agent` i `token`. `role` to nazwa roli z konfiguracji, `agent` to identyfikator dziecka znany hookowi, `token` to HMAC liczony z sekretu wspólnego dla adaptera i handlera na tej samej maszynie nad ciągiem `v|role|agent`. Token obejmuje więc każde pole, które wpływa na routing. Sekret pochodzi ze środowiska, nigdy z pliku konfiguracji ani z promptu.
- Każde odstępstwo od tych dwóch gramatyk w autoryzowanej pozycji, w tym mieszanie atrybutów obu wariantów, niedozwolone znaki, brak zamknięcia albo nieznany atrybut, to błąd `invalid-marker`, nie brak markeru.
- Markery są klasyfikowane według źródła: `explicit` dla wariantu rodzica, `role-default` dla wariantu adaptera. Między źródłami obowiązuje kolejność z wymagania 18, więc marker rodzica wygrywa z markerem roli. Dwa różne markery z tego samego źródła to błąd `conflicting-markers`. Identyczne markery są traktowane jak jeden.
- Składnia jest własnością tego projektu. Nie ma zgodności drop-in ze znacznikiem CCR.

Autoryzowane pozycje markeru:

1. Bloki `system` requestu, wyłącznie dla wariantu adaptera z poprawnym `token`, którego `agent` zgadza się z identyfikatorem dziecka w requeście. Wariant rodzica, marker bez tokenu albo z błędnym tokenem w bloku `system` jest ignorowany z kodem `ignored-marker`. Ta zasada chroni przed markerem przemyconym przez treść `CLAUDE.md`, instrukcje projektu albo inny tekst systemowy, którego adapter nie wystawił.
2. Pierwsza linia pierwszego bloku tekstowego pierwszej wiadomości o roli `user`, o ile ta wiadomość nie zawiera bloków `tool_result`. To jest początek promptu delegacji napisanego przez rodzica i przyjmowany jest tu wyłącznie wariant rodzica. Wariant adaptera w tej pozycji jest przyjmowany tylko wtedy, gdy pomiar M3 wykaże, że `additionalContext` ląduje właśnie tam; wtedy obowiązuje ta sama weryfikacja tokenu co w bloku `system`. Marker w dalszej części tej wiadomości jest ignorowany z kodem `ignored-marker`.

Marker w dowolnej innej pozycji, w tym w blokach `tool_result`, w późniejszych wiadomościach i w treści odpowiedzi asystenta, jest ignorowany. Rodzic z cytowanym markerem przechodzi pass-through.

Ryzyko resztkowe kanału rodzica: rodzic, który skopiuje obcy tekst z markerem do pierwszej linii własnego promptu delegacji, wybiera ten model tak, jakby zrobił to sam. Skutek jest ograniczony do allowlist. Specyfikacja przyjmuje to ryzyko, bo rodzic jest z założenia stroną wybierającą, a instrukcja narzędzia delegacji każe umieszczać marker jako pierwszą linię własnego tekstu.

Kanały, którymi wybór dociera do dziecka:

- Kanał A, jawny wybór rodzica: rodzic umieszcza marker jako pierwszą linię promptu delegacji. Opis narzędzia delegacji, dostarczony przez adapter jako instrukcja w kontekście rodzica, wymienia katalog i składnię. Prompt delegacji jest pierwszą wiadomością `user` każdego kolejnego turnu świeżego subagenta, więc wybór jest widoczny w każdym requeście bez pamięci po stronie handlera. [inferred z pozycji parsowania CCR i z budowy rozmowy subagenta]
- Kanał B, domyślny model roli: hook `SubagentStart` adaptera zna `agent_id` i `agent_type`, liczy `token` i wstrzykuje wariant adaptera markeru przez `additionalContext`. Dzięki temu rola ma model domyślny nawet wtedy, gdy rodzic nie wskazał modelu. Jeżeli pomiar M3 wykaże, że `additionalContext` nie trafia do bloku `system` ani do pierwszej wiadomości `user`, adapter przełącza się na kanał B2: hook rejestruje parę `agent_id` i rola bezpośrednio w handlerze przez lokalny endpoint uwierzytelniony tym samym sekretem. Kanał B2 nie zależy od treści promptu.
- Kanał C, korelacja po identyfikatorze dziecka: przy pierwszym routowanym requeście handler zapamiętuje parę identyfikator dziecka i decyzja w ulotnej mapie procesu z limitem czasu. Kolejne requesty z tym samym identyfikatorem i potwierdzonym pochodzeniem otrzymują tę samą decyzję ze źródłem `correlated`, także gdy kompakcja usunęła marker z historii. Identyfikator pochodzi z nagłówka `x-claude-code-agent-id`. Claude Code nie wysyła osobnego identyfikatora sesji, więc klucz nie może zawierać sesji, a bezpieczeństwo kanału opiera się na losowości identyfikatora dziecka. Kanał C jest aktywny tylko wtedy, gdy pomiar M1 potwierdzi dla danej wersji obecność nagłówka w każdym requeście dziecka oraz losowość identyfikatora wystarczającą, by kolizja między sesjami była praktycznie niemożliwa. Adapter przechowuje listę wersji z zaliczonym M1 i nie ma ustawienia, które włącza kanał C bez tego zaliczenia. Bez zaliczenia kanał C jest wyłączony, a utrata markeru kończy się według wymagania 19.

Pochodzenie od dziecka potwierdza wyłącznie `cc_is_subagent=true` w metadanych billing, tak jak w CCR. Nagłówek identyfikatora agenta służy korelacji, nie uwierzytelnieniu pochodzenia. Request z korelowanym identyfikatorem, który niesie poprawny marker o innej decyzji, kończy się błędem `correlation-conflict`, bo wskazuje na kolizję identyfikatora albo próbę przejęcia.

Pamięć korelacji: mapa w pamięci procesu, klucz to identyfikator instancji handlera i identyfikator dziecka, wartość to decyzja, źródło i znacznik czasu, limit czasu konfigurowalny z domyślną wartością jednej godziny od ostatniego użycia, brak zapisu na dysk. Restart handlera gubi mapę. Dziecko, którego marker zniknął po kompakcji i którego wpis zginął z restartem, kończy się błędem `missing-selection` zgodnie z wymaganiem 19. To jest akceptowane jako błąd widoczny, nie jako cicha zmiana modelu. Kanał A odtwarza decyzję z promptu delegacji, dopóki kompakcja go nie usunie.

### Decyzja D3: fork w Claude Code jest poza gwarancją pierwszej implementacji

Rozstrzyga lukę 2 w części projektowej.

Fork dziedziczy model, kontekst i historię rozmowy głównej. Prompt delegacji forka nie jest pierwszą wiadomością `user`, więc kanał A go nie obejmuje. Nie wiadomo, czy `SubagentStart` uruchamia się dla forka ani czy request forka niesie `cc_is_subagent=true`. Bez tych faktów nie da się bezpiecznie odróżnić forka od rodzica.

Decyzja: pierwsza implementacja nie obiecuje routingu forków. Request forka bez rozpoznanego pochodzenia jest traktowany jak rodzic i przechodzi pass-through. Request forka z rozpoznanym pochodzeniem, ale bez wskazania, podlega wymaganiu 19 jak każde inne dziecko. Kryterium akceptacyjne 6 pozostaje w specyfikacji jako cel drugiego etapu i zależy od pomiaru M4. Wymagania 27 do 30 pozostają w mocy jako opis docelowy.

### Decyzja D4: format konfiguracji i granica między caller a środowiskiem

Rozstrzyga lukę 8.

Jeden plik `subagent-router.json`:

```json
{
  "version": 1,
  "models": {
    "gateway/fast-worker": {
      "alias": "fast",
      "description": "Szybkie zadania mechaniczne i wyszukiwanie.",
      "clientModel": "haiku"
    },
    "gateway/reviewer": {
      "alias": "review",
      "description": "Niezależny przegląd i trudne debugowanie.",
      "clientModel": "sonnet"
    }
  },
  "roles": {
    "explorer": { "default": "gateway/fast-worker" },
    "reviewer": { "default": "gateway/reviewer" }
  },
  "defaults": {
    "child": null,
    "unmarkedSubagent": "error"
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

Zasady:

- `models` to allowlist. Klucz jest opaque `upstreamModel`. `alias` jest krótką, unikalną nazwą używaną w nazwach wariantów agentów i w katalogu pokazywanym rodzicowi. `description` zasila ten katalog. `clientModel` jest opcjonalny i używany tylko przez adaptery, które inicjalizują harness aliasem.
- `roles` mapują nazwę roli harnessu, na przykład `agent_type` w Claude Code, nazwę agenta w OpenCode albo nazwę roli w Codex, na model domyślny.
- `defaults.child` to globalny model domyślny dzieci albo `null`. `defaults.unmarkedSubagent` przyjmuje `error` albo `inherit`. Wartością domyślną jest `error`. `inherit` jest jawną zgodą operatora opisaną w wymaganiu 19 i walidator wymaga przy niej pola `"unmarkedSubagentAcknowledged": true`, żeby zgoda była widoczna w pliku.
- `gateway` nie zawiera wartości URL ani nagłówków. Zawiera nazwy zmiennych środowiskowych. Wartości nagłówków są czytane ze środowiska w chwili startu i nigdy nie są logowane.
- `harness.claudeCode.correlation` przyjmuje `auto` albo `off`. `auto` włącza kanał C tylko dla wersji z zaliczonym M1 na liście adaptera. Nie ma wartości wymuszającej kanał C bez zaliczenia. `secretEnv` wskazuje zmienną z sekretem tokenu markeru.
- `harness.opencode.providerId` to identyfikator providera z `opencode.json`, którego generator używa w polu `model` wariantów.
- `harness.codex.emitModelCatalog` włącza generowanie `model_catalog` z allowlist, gdy pomiar M5 wykaże, że Codex odrzuca modele spoza katalogu. Wpis katalogu ma identyfikator równy `upstreamModel` i nazwę równą `alias`.
- Precedencja: argumenty caller, potem środowisko, potem plik. Aplikacja embed przekazuje obiekt bezpośrednio i może pominąć plik oraz środowisko.
- Plik NIE MOŻE zawierać sekretów. Walidator konfiguracji odrzuca wartości nagłówków podane inline.
- Nieznane pola i nieznana `version` są błędem walidacji, nie ostrzeżeniem.

Generatory konfiguracji harnessów czytają ten sam plik i produkują: definicje subagentów oraz instrukcję katalogu dla Claude Code, warianty agentów dla OpenCode, pliki ról i `default_subagent_model` dla Codex.

### Decyzja D5: adapter OpenCode przez generowane warianty agentów

Rozstrzyga lukę 6.

Ponieważ Task nie przyjmuje modelu, wybór modelu dla dziecka jest wyborem agenta. Generator tworzy dla każdej pary rola i model wariant agenta o nazwie `ROLE@ALIAS`, gdzie `ALIAS` to pole `alias` modelu z konfiguracji. Wariant kopiuje z agenta bazowego prompt, narzędzia, uprawnienia i tryb, a ustawia `model` na `PROVIDER_ID/upstreamModel` z `harness.opencode.providerId` oraz `hidden: true`, żeby nie zaśmiecać autouzupełniania. Opis wariantu zawiera opis modelu z katalogu, więc rodzic wybiera wariant przez `subagent_type` na podstawie opisu. Generator dopisuje też brakujące identyfikatory z allowlist do sekcji `models` wskazanego providera, bo według odczytu źródła OpenCode odrzuca model spoza tej sekcji; pomiar M6 to potwierdza.

Plugin nie jest wymagany w pierwszej implementacji. Opcjonalny plugin `chat.headers` dodaje nagłówek diagnostyczny z nazwą agenta do requestów, co ułatwia test akceptacyjny z kontrolowaną bramą. Plugin `tool.execute.before` NIE JEST używany do podmiany `subagent_type`, bo wybór ma pochodzić od rodzica, nie od ukrytej reguły.

Warunek zaliczenia: pomiar M6 potwierdza, że wariant dziedziczy prompt, narzędzia i uprawnienia agenta bazowego oraz że wznowienie dziecka zachowuje model wariantu.

### Decyzja D6: adapter Codex przez role, model w spawn i hook walidujący

Rozstrzyga lukę 7.

Rodzic podaje `model` w `spawn_agent` bezpośrednio jako opaque identyfikator bramy. Generator tworzy pliki ról z modelem domyślnym roli i ustawia `agents.default_subagent_model`, gdy skonfigurowano `defaults.child`. Hook `PreToolUse` z matcherem `Agent` jest obowiązkową częścią adaptera: waliduje `model` względem allowlist i odrzuca wywołanie z niedozwolonym modelem przez `permissionDecision: "deny"`. Hook NIE stosuje `updatedInput` do cichej podmiany modelu, bo byłoby to fallbackiem sprzecznym z wymaganiem 23.

Jeżeli pomiar M7 wykaże, że hook nie otrzymuje `model` albo `deny` nie zatrzymuje uruchomienia dziecka, adapter Codex odmawia działania dla tej wersji z kodem `unsupported-path`, zgodnie z wymaganiem 33. Tryb „tylko role” nie jest dopuszczalnym zamiennikiem, bo nie zatrzymuje bezpośredniego `spawn_agent` z modelem spoza allowlist. Sam generator ról nie jest walidacją runtime i nie spełnia wymagania 10.

Precedencja między jawnym `model` w `spawn_agent` a modelem roli nie wynika jednoznacznie ze źródła. Pomiar M9 ją ustala. Do czasu wyniku adapter zakłada, że jawna wartość wygrywa, zgodnie z dokumentacją subagentów, i zgłasza `unsupported-path`, gdy M9 wykaże inaczej dla wspieranej wersji.

Wersja bazowa: dokumentacja hooków opisuje zachowanie wydania, więc adapter wymaga wydanego Codex w wersji co najmniej `rust-v0.153.4`. Lokalna wersja `0.150.0-alpha.8` jest niższa i musi zostać zaktualizowana przed pomiarami M5, M7 i M9.

### Decyzja D7: limity kontekstu i format reasoning są zaakceptowanym ograniczeniem

Rozstrzyga lukę 5.

Pakiet nie zarządza limitami kontekstu ani formatem reasoning. W trybie `marker-routed` klient inicjalizuje limity według `clientModel`, a brama obsługuje `upstreamModel`. Rozjazd jest możliwy i celowo nie jest korygowany po stronie routera. Łagodzenie: pole `clientModel` w katalogu pozwala dobrać alias klienta bliski klasie modelu upstream, a handler zapisuje w diagnostyce parę `clientModel` i `upstreamModel` dla każdej decyzji.

Ta decyzja zamyka lukę jako świadomie przyjęte ograniczenie. Pomiar M8 jest informacyjny: nie bramkuje statusu `implemented`, ale jego wynikiem musi być tabela w dokumentacji bloku z przetestowanymi parami `clientModel` i `upstreamModel` oraz obserwowanym zachowaniem przy długim kontekście.

### Decyzja D8: wersje bazowe

Rozstrzyga lukę 1.

Wersje bazowe pierwszej implementacji to wersje zmierzone w tym dokumencie: Claude Code 2.1.263, OpenCode 1.18.29, Codex co najmniej rust-v0.153.4, Bun 1.3.11. Adapter deklaruje wersję bazową w kodzie i odmawia działania z kodem `unsupported-path`, gdy wykryta wersja jest niższa. Nowsza wersja jest dopuszczana z ostrzeżeniem w diagnostyce do czasu zaliczenia scenariuszy akceptacyjnych.

## Pomiary wymagane przed statusem implemented

Każdy pomiar ma kryterium rozstrzygające. Wynik ujemny nie unieważnia projektu, tylko wyłącza wskazany kanał albo przenosi funkcję do drugiego etapu.

| Id | Pytanie | Metoda | Kryterium | Skutek wyniku ujemnego |
|---|---|---|---|---|
| M1 | Czy Claude Code 2.1.263 wysyła `x-claude-code-agent-id` w każdym requeście dziecka, także po kompakcji, i czy identyfikator jest losowy oraz unikalny między sesjami i uruchomieniami? | Kontrolowana brama zapisuje nagłówki wszystkich requestów subagentów w dwóch równoległych sesjach, jednej wznowionej i jednej z wymuszoną kompakcją. | Nagłówek obecny i stały w każdym requeście danego dziecka; identyfikatory różne między dziećmi, sesjami i uruchomieniami; format wskazuje na losowość co najmniej 64 bitów. | Kanał C wyłączony dla tej wersji; utrata markeru po kompakcji kończy się `missing-selection`. |
| M2 | Czy parametr `model` wywołania Agent przyjmuje pełny identyfikator mimo schematu z aliasami? | Wywołanie z pełnym identyfikatorem i obserwacja `clientModel` w requeście. | Request niesie podany identyfikator. | `clientModel` w katalogu ograniczony do aliasów. |
| M3 | Gdzie ląduje `additionalContext` z `SubagentStart` w requeście dziecka? | Hook wstrzykuje marker testowy z tokenem, brama zapisuje body. | Marker w bloku `system` albo w pierwszej linii pierwszej wiadomości `user`. | Kanał B zastąpiony kanałem B2 z rejestracją `agent_id` w handlerze. |
| M4 | Czy fork niesie `cc_is_subagent=true` i czy `SubagentStart` uruchamia się dla forka? | Fork z hookiem i bramą zapisującą body. | Oba warunki spełnione. | Fork pozostaje pass-through, kryterium 6 zostaje w drugim etapie. |
| M5 | Czy Codex z własnym `model_providers` bez `model_catalog` akceptuje nieznany identyfikator modelu w `spawn_agent`? | Spawn z opaque identyfikatorem przeciw bramie zapisującej body. | Request dziecka niesie identyfikator bez zmian. | Generator działa z `harness.codex.emitModelCatalog: true` i wytwarza katalog z allowlist. |
| M6 | Czy wariant agenta OpenCode dziedziczy prompt, narzędzia i uprawnienia bazowego agenta, czy model spoza `models` providera jest odrzucany i czy model wariantu jest zachowany po wznowieniu? | Porównanie rozwiązanej konfiguracji wariantu i bazy, spawn z modelem spoza providera, test wznowienia z bramą. | Różnica tylko w `model`, `name`, `description`, `hidden`; model spoza providera odrzucony; model po wznowieniu bez zmian. | Generator kopiuje brakujące pola jawnie albo adapter odmawia. |
| M7 | Czy hook `PreToolUse` z matcherem `Agent` w wydanym Codex otrzymuje `model` i respektuje `deny`? | Hook logujący wejście i odrzucający niedozwolony model. | Wywołanie odrzucone bez uruchomienia dziecka. | Adapter Codex odmawia działania dla tej wersji z kodem `unsupported-path`. |
| M9 | Jaka jest precedencja między jawnym `model` w `spawn_agent` a modelem roli w wydanym Codex? | Rola z modelem B, spawn tej roli z jawnym modelem C, brama zapisuje model dziecka. | Brama odbiera C. | Adapter zgłasza jawne pole przy roli jako `unsupported-path` i instruuje rodzica, by wybierał rolę. |
| M10 | Czy `upstreamModel` dziecka jest stały przez każde wspierane przejście lifecycle w każdym harnessie: kolejne tury, wznowienie, kompakcja, dziecko zagnieżdżone, dziecko równoległe? | Dla każdego harnessu scenariusz z bramą zapisującą model każdego requestu i identyfikator dziecka. | Każdy request danego dziecka niesie ten sam `upstreamModel`; dzieci różnią się między sobą; rodzic bez zmian. | Niezaliczone przejście jest oznaczone jako niewspierane w dokumentacji adaptera, a adapter zgłasza je jako `unsupported-path`, gdy potrafi je wykryć. |

Pomiar informacyjny, poza bramką statusu:

| Id | Pytanie | Metoda | Wymagany artefakt |
|---|---|---|---|
| M8 | Jakie skutki ma rozjazd `clientModel` i `upstreamModel` dla limitów i reasoning? | Dziecko z aliasem `haiku` i modelem upstream o innym limicie, test długiego kontekstu. | Tabela par i obserwacji w dokumentacji bloku adaptera Claude Code. |

Diagnostyka MOŻE zawierać nazwę adaptera, identyfikator korelacyjny, wybrany identyfikator modelu, `clientModel`, źródło decyzji, kod decyzji i listę zignorowanych markerów bez ich treści. NIE MOŻE zawierać promptów, wyników narzędzi, treści odpowiedzi, sekretu tokenu ani wartości nagłówków autoryzacji.

Do zamknięcia pozostają wyłącznie pomiary M1 do M7, M9 i M10. Każdy wynik ujemny ma z góry ustalony skutek, więc żadna decyzja projektowa nie jest otwarta. Wersję klienta można oznaczyć jako wspieraną dopiero po zaliczeniu jej scenariuszy akceptacyjnych.

## Alternatywy i decyzje

### Własny agent loop

Odrzucone. Dublowałoby natywne narzędzia, uprawnienia, UI i lifecycle, które projekt ma zachować.

### Wybór tylko przez natywne pole modelu

Odrzucone dla Claude Code. Pole nie przyjmuje dowolnych identyfikatorów bramy, hooki nie mogą go zmienić, a fork je ignoruje. Przyjęte dla OpenCode i Codex jako tryb `native`, bo tam pole jest dosłownie `upstreamModel`.

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

## Kryteria akceptacji

Następujące kryteria są wymaganiami przyszłego wdrożenia. Nie są obecnie spełnione ani przetestowane.

1. Parent używa modelu A, a równoczesne dzieci używają modeli B i C. Kontrolowana brama potwierdza rzeczywiście odebrane `upstreamModel` dla każdego requestu. Kryterium obowiązuje osobno dla każdego z trzech harnessów.
2. Test używa dowolnych opaque identifiers i po zmianie endpointu bramy nie dodaje gałęzi routingu po vendorze.
3. Dziecko wywołuje narzędzie, otrzymuje jego wynik i zwraca poprawnie zdekodowaną odpowiedź końcową. Deklaracja modelu o własnej nazwie nie jest dowodem właściwego routingu.
4. Parent pozostaje niezmieniony, gdy marker jest tylko cytowany w historii, w wyniku narzędzia, w odpowiedzi asystenta, w dalszej części promptu delegacji albo w bloku `system` bez poprawnego tokenu, na przykład przemycony przez `CLAUDE.md`. Dziecko z takim markerem poza autoryzowaną pozycją jest obsługiwane tak, jakby markeru nie było, z kodem `ignored-marker`.
5. Zagnieżdżone dzieci i niezależne równoległe sesje nie mają wycieku decyzji ani stanu. Dwa dzieci z różnymi identyfikatorami i różnymi markerami otrzymują różne `upstreamModel` w tym samym procesie handlera. Wymuszona kolizja identyfikatora z odmiennym markerem kończy się `correlation-conflict`, a nie decyzją pierwszego dziecka.
6. Fork z odziedziczonym `clientModel` i odmiennym `upstreamModel` jest sprawdzony osobno przez kontrolowaną bramę. Kryterium drugiego etapu, zależne od M4.
7. Dla wspieranej wersji klienta wieloturowa praca dziecka, resume i compaction zachowują jego wybór modelu, potwierdzony przez pomiar M10 dla każdego harnessu. Oddzielne testy utraty informacji o trasie wymagają zachowania według wymagania 19. Sam błąd `unsupported-path` nie zalicza scenariusza działającej integracji.
8. Nieznany, niejednoznaczny albo niedozwolony target rozpoznanego dziecka objętego routingiem powoduje błąd bez wywołania bramy. Obcy lub cytowany marker rodzica, również z nieznanym modelem, nie uruchamia tej walidacji i nie blokuje jego requestu.
9. Cancellation i stream backpressure przechodzą przez handler bez zmiany semantyki.
10. Core buduje i działa w środowisku bez zależności Bun-only.
11. Testy fake gateway są hermetyczne i stanowią pierwszą linię walidacji.
12. Opt-in testy realnych harnessów działają przeciw zewnętrznej bramie, nie przechowują sekretów i raportują wersje harnessów.
13. Walidator konfiguracji odrzuca plik z nieznaną wersją, nieznanym polem albo wartością nagłówka podaną inline.
14. Generator konfiguracji harnessu nie nadpisuje istniejącego pliku bez jawnej flagi i nie dotyka plików poza wskazaną ścieżką.

## Strategia testów

[assumption] Warstwy testów powinny oddzielać deterministyczny core, HTTP handler i adaptery harnessów.

- Testy core sprawdzają katalog, priorytet decyzji, allowlist, konflikty markerów, brak fallbacku, izolację sesji i kody decyzji.
- Testy handlera z fake gateway przechwytują request, `upstreamModel`, body bez markera, anulowanie, backpressure oraz zachowanie mapy korelacji po limicie czasu.
- Testy generatorów porównują wyprodukowaną konfigurację harnessu z oczekiwanym wynikiem i sprawdzają odmowę nadpisania.
- Testy adaptera potwierdzają przekazanie wiarygodnego kontekstu dziecka oraz jawny błąd na nieobsługiwanej ścieżce.
- Testy E2E są opt-in, nie zapisują sekretów, raportują wersję harnessu oraz bramy i realizują pomiary M1 do M7, M9 i M10 jako osobne, nazwane scenariusze bramkujące. Pomiar M8 jest osobnym scenariuszem informacyjnym, którego wynik trafia do dokumentacji bloku.

Sukces E2E wymaga zarówno capture z kontrolowanej bramy, jak i znaczącego, zdekodowanego roundtripu narzędzia dziecka oraz wyniku końcowego. Sam tekst odpowiedzi modelu nie wystarcza.

## Related

- [Indeks dokumentacji](../../README.md)
- [Konwencje dokumentacji](../../CONVENTIONS.md)
- [CCR, pinned commit `c49733678660f726540fca3fff20bbd7d6cab032`](https://github.com/kolezka/claude-code-router/tree/c49733678660f726540fca3fff20bbd7d6cab032)
- [Claude Code sub-agents documentation](https://code.claude.com/docs/en/sub-agents)
- [Claude Code hooks documentation](https://code.claude.com/docs/en/hooks)
- [OpenCode, pinned commit `337fd144d2ba144743368f78d9579a99cce175bd`](https://github.com/anomalyco/opencode/tree/337fd144d2ba144743368f78d9579a99cce175bd)
- [OpenCode agents documentation](https://opencode.ai/docs/agents/)
- [Codex, pinned commit `ac192cd7937b0d73edc6dffe009940ae53782dd4`](https://github.com/openai/codex/tree/ac192cd7937b0d73edc6dffe009940ae53782dd4)
- [Codex hooks documentation](https://learn.chatgpt.com/docs/hooks)
- [Codex subagents documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents)
