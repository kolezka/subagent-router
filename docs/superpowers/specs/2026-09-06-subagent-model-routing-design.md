# Routing modeli subagentów

Date: 2026-09-06

Status: draft

## Cel

`subagent-router` ma umożliwić rodzicowi świadomy wybór modelu dla konkretnego natywnego subagenta bez zmiany modelu rodzica. Jedno uruchomienie może jednocześnie obsługiwać dzieci używające różnych modeli i różnych dostawców, o ile skonfigurowana brama je obsługuje.

Projekt ma być małym pakietem Bun + TypeScript. Ma działać jako biblioteka importowana przez inne narzędzia oraz samodzielnie przez CLI. Jest to jeden pakiet, nie monorepo.

Dokument opisuje proponowany projekt. Status `draft` nie oznacza akceptacji wszystkich szczegółów ani zgody na rozpoczęcie implementacji.

## Stan i zakres dowodów

Stan na 2026-09-06: repozytorium zawiera dokumentację, bez implementacji i testów routera. Nie wykonano testów E2E nowego zachowania. [verified]

[verified] CCR ma istniejący mechanizm inspirujący dla Claude Code. Symbol [`resolveBuiltInClaudeCodeSubagentRouteDecision`](https://github.com/kolezka/claude-code-router/blob/c49733678660f726540fca3fff20bbd7d6cab032/packages/core/src/gateway/claude-code-router-plugin.ts) wybiera model na podstawie tagu. Symbol [`extractAndRemoveClaudeCodeSubagentModelTag`](https://github.com/kolezka/claude-code-router/blob/c49733678660f726540fca3fff20bbd7d6cab032/packages/core/src/gateway/claude-code-router-plugin.ts) analizuje i usuwa tag. Symbole [`removeClaudeCodeBillingSystemHeader`](https://github.com/kolezka/claude-code-router/blob/c49733678660f726540fca3fff20bbd7d6cab032/packages/core/src/gateway/claude-code-router-plugin.ts) oraz [`ccrSubagentToolModelInstruction`](https://github.com/kolezka/claude-code-router/blob/c49733678660f726540fca3fff20bbd7d6cab032/packages/core/src/gateway/claude-code-router-plugin.ts) pokazują odpowiednio obsługę nagłówka billing i instrukcję z polem modelu oraz markerem.

[verified] Aktualna dokumentacja [Claude Code sub-agents](https://code.claude.com/docs/en/sub-agents), odczytana 2026-09-06, opisuje precedencję konfiguracji modelu i natywne dziedziczenie modelu w trybie fork. Jest to źródło poziomu dokumentacji, nie dowód E2E dla wszystkich ścieżek fork.

[verified] W OpenCode symbol [`TaskTool`](https://github.com/anomalyco/opencode/blob/337fd144d2ba144743368f78d9579a99cce175bd/packages/opencode/src/tool/task.ts) wybiera model dziecka z konfiguracji agenta albo model rodzica. Narzędzie task nie ma argumentu model.

[verified] W Codex symbol [`spawn_agent_common_properties_v1`](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/src/tools/handlers/multi_agents_spec.rs) zawiera pole `model`. W [`registry.rs`](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/src/tools/registry.rs) widoczna jest ścieżka dispatch dla `updated_input`. Źródło nie potwierdza minimalnej wydanej wersji binarnej ani zachowania w działającej sesji.

## Wymagania normatywne

### Produkt i granice

1. Pakiet MUSI być pojedynczym pakietem Bun + TypeScript, bez monorepo.
2. Core MUSI być czysty i importowalny bez obowiązkowego procesu serwera.
3. Core NIE MOŻE zależeć od SDK harnessów.
4. Bun jest dozwolony w CLI i trybie standalone, ale core NIE MOŻE wymagać API specyficznego dla Bun.
5. CLI MOŻE wystawić jawny config, hook entry i `serve`.
6. CLI NIE MOŻE automatycznie modyfikować istniejących globalnych ustawień użytkownika.
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
19. Dziecko nieobjęte konfiguracją routingu przechodzi bez zmian. Dla dziecka objętego routingiem brak wyboru i wartości domyślnej oznacza błąd, chyba że konfiguracja jawnie zezwala na dziedziczenie. Brak lub utrata oczekiwanego markera NIE JEST zgodą na dziedziczenie.
20. Parent bez dopasowania MUSI przejść pass-through.
21. Jawnie routowane child z nieznanym modelem, modelem niedozwolonym, sprzecznymi markerami albo nieobsługiwaną ścieżką MUSI zakończyć się błędem.
22. W takich przypadkach NIE WOLNO cicho użyć modelu rodzica.
23. Pakiet NIE MOŻE automatycznie wybrać innego modelu po błędzie routingu.

### Model klienta i model upstream

24. Dokumentacja i kontrakty MUSZĄ rozróżniać `clientModel` od `upstreamModel`.
25. `clientModel` to ustawienie używane do walidacji, inicjalizacji harnessu i, gdzie obsługiwane, limitów właściwych dla klienta.
26. `upstreamModel` to model realnie wysyłany do skonfigurowanej bramy.
27. Natywny fork MOŻE odziedziczyć `clientModel`, a routing requestu MOŻE wybrać odmienny `upstreamModel`.
28. Wybór rzeczywistego modelu NIE MOŻE zależeć wyłącznie od natywnego pola modelu harnessu.
29. Przypadek fork z odziedziczonym `clientModel` i innym `upstreamModel` MUSI mieć osobny przypadek akceptacyjny.
30. Specyfikacja NIE twierdzi, że różne fork są już przetestowane.

### Routing przed bramą

31. Warstwa routingu przed bramą jest częścią zakresu pierwszej implementacji.
32. Core, client adapters oraz cienki HTTP handler lub CLI `serve` MUSZĄ wspólnie zapewnić routing markerów w stylu CCR dla Claude.
33. Aplikacja embed MUSI móc użyć tego samego handlera bez uruchamiania dodatkowego procesu proxy.
34. Handler MUSI wysyłać routing upstream do bramy skonfigurowanej przez caller lub środowisko.
35. Handler NIE MOŻE wyprowadzać URL upstream z promptu ani z request content.
36. Konfiguracja endpointu forwarding i nagłówków MUSI pochodzić od caller lub środowiska.
37. Sekrety NIE MOGĄ trafiać do promptów, markerów ani diagnostyki.
38. Handler MOŻE czytać routing JSON tylko dla obsługiwanych requestów.
39. Odpowiedzi i stream MUSZĄ być pass-through. Pakiet NIE MOŻE wykonywać protocol translation.
40. Anulowanie i backpressure streamu MUSZĄ przejść do upstream bez semantycznej zmiany.

### Niezależność od bramy

41. `9router` i `omnirouter` są zewnętrzną warstwą protokołów, auth do dostawców i obsługi dostawców.
42. `subagent-router` MUSI być niezależny od obu tych projektów.
43. Pakiet NIE MOŻE zawierać adapterów bram, implementacji auth dostawców ani routingu po vendorze.
44. Wymiana endpointu bramy przy tych samych opaque model identifiers NIE MOŻE wymagać gałęzi kodu routera.

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
- przenieść decyzję do routing handlera w obsługiwany sposób,
- odmówić jawnie, gdy nie potrafi bezpiecznie zachować wyboru,
- nie zmieniać modelu ani uprawnień rodzica.

Adapter NIE GWARANTUJE:

- tej samej jakości modelu,
- równych capabilities modeli,
- zgodnych limitów kontekstu,
- zgodnego formatu reasoning.

Ostatnie dwa punkty są luką inicjalizacji do sprawdzenia, nie podstawą do cichej zmiany `upstreamModel`.

### Routing handler

[assumption] Cienki handler rozpoznaje kontrolowany marker bieżącego dziecka, wylicza decyzję core, usuwa marker wyłącznie z kopii requestu wysyłanej upstream i przekazuje request do skonfigurowanej bramy.

Oryginalna historia klienta NIE MOŻE być mutowana. Handler NIE MOŻE uznać za upoważniony dowolnego markera odnalezionego w dawnej historii, tool results lub cytowanym tekście.

Dokładna składnia markeru jest decyzją implementacyjną. MUSI być jednoznaczna i wersjonowalna lokalnie, ale NIE MUSI zachować kompatybilności typu drop-in z CCR.

### Konfiguracja

[assumption] Konfiguracja opisuje katalog modeli, role, defaulty, endpoint forwarding i dozwolone nagłówki. Opaque identyfikatory są danymi konfiguracji, nie logiką kodu.

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

1. `pass-through` dla rodzica, dziecka nieobjętego routingiem albo jawnie dozwolonego dziedziczenia.
2. `route` z jednym zwalidowanym opaque `upstreamModel` dla rozpoznanego dziecka.
3. `error` dla dziecka objętego routingiem, gdy wybór jest niepoprawny, brakujący albo nieobsługiwany.

Nie istnieje wynik znaczący „spróbuj modelu rodzica”.

### Invariant izolacji rodzica

Model rodzica, jego uprawnienia, narzędzia i lifecycle pozostają bez zmian. Zmiana dotyczy tylko requestu zakwalifikowanego jako konkretne dziecko.

### Invariant wiarygodnego pochodzenia

Marker jest sygnałem transportowym wygenerowanym przez adapter dla bieżącego dziecka. Nie jest instrukcją tekstową dla modelu i nie może być zaakceptowany, gdy występuje tylko w nieautoryzowanej części danych requestu.

### Invariant braku wycieku decyzji

Równoległe i zagnieżdżone dzieci, a także niezależne sesje, nie dzielą wyboru modelu. Anulowanie jednej sesji nie może zmienić decyzji drugiej.

### Invariant przejrzystej porażki

Dla dziecka objętego routingiem brak bezpiecznej trasy kończy obsługę błędem przed wywołaniem upstream. Nie powoduje zastąpienia modelu modelem rodzica. Zwykły ruch rodzica i dzieci nieobjętych routingiem pozostaje bez zmian.

### Invariant transportu

Po podjęciu decyzji handler usuwa marker z kopii requestu upstream. Poza wymaganymi zmianami routingu przekazuje body, odpowiedź, stream, anulowanie i backpressure bez translacji protokołu.

## Adapter Claude Code

[verified] CCR pokazuje precedent instrukcji modelu plus marker i późniejszego wyboru modelu, ale nie jest kontraktem kompatybilności tego pakietu. Zobacz [`ccrSubagentToolModelInstruction`](https://github.com/kolezka/claude-code-router/blob/c49733678660f726540fca3fff20bbd7d6cab032/packages/core/src/gateway/claude-code-router-plugin.ts) oraz [`resolveBuiltInClaudeCodeSubagentRouteDecision`](https://github.com/kolezka/claude-code-router/blob/c49733678660f726540fca3fff20bbd7d6cab032/packages/core/src/gateway/claude-code-router-plugin.ts).

[assumption] Adapter Claude Code przekazuje katalog i wybór w natywnej delegacji oraz dołącza jawny marker transportowy. Jeżeli harness pozwala ustawić `clientModel` dla właściwych limitów, adapter może to zrobić. Rzeczywisty wybór `upstreamModel` pozostaje po stronie routingu requestu.

[assumption] Natywny fork może dziedziczyć `clientModel`. To nie jest dowód, że każdy fork zachowa odmienny `upstreamModel` przez całą ścieżkę.

Rozpoznanie bieżącego dziecka i przeniesienie wyboru przez resume, compaction i fork jest kontraktem wymagającym weryfikacji. Jeżeli adapter nie umie zachować go bezpiecznie, musi zwrócić jawny błąd.

## Adapter OpenCode

[verified] [`TaskTool`](https://github.com/anomalyco/opencode/blob/337fd144d2ba144743368f78d9579a99cce175bd/packages/opencode/src/tool/task.ts) nie przyjmuje argumentu model. Model dziecka wynika z konfiguracji agenta albo modelu rodzica.

[assumption] Adapter wybiera alias albo wariant agenta reprezentujący wybraną rolę i model. Musi zachować role instructions, tools, permissions oraz lifecycle natywnego agenta.

To jest propozycja wymagająca prób. Adapter nie może zmienić modelu rodzica ani jego uprawnień, a brak bezpiecznej ścieżki kończy się błędem zamiast dziedziczenia modelu rodzica.

## Adapter Codex

[verified] Kod źródłowy Codex zawiera pole `model` w [`spawn_agent_common_properties_v1`](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/src/tools/handlers/multi_agents_spec.rs) oraz dispatch `updated_input` w [`registry.rs`](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/src/tools/registry.rs).

[inferred] Identyfikator bramy może być przekazany w obrębie wspólnego providera sesji, ale wymaga potwierdzenia w wydanym binarium.

Minimalna wydana wersja Codex nie jest ustalona. Adapter MUSI wykryć wspieraną ścieżkę. Nieobsługiwana ścieżka MUSI zwrócić jawny błąd i NIE MOŻE cicho fallbackować.

## Luki i otwarte decyzje

1. Minimalne wersje Claude Code, OpenCode i Codex wymagające adapterów nie są jeszcze ustalone.
2. Nie potwierdzono E2E zachowania wszystkich wariantów fork Claude Code.
3. Nie potwierdzono zachowania wyboru przez resume, multiturn, compaction i zagnieżdżone forki.
4. Nie ustalono bezpiecznej, lokalnie wersjonowanej składni markeru.
5. Nie zmierzono zgodności limitów kontekstu, formatów reasoning ani capabilities przy rozdzieleniu `clientModel` i `upstreamModel`.
6. Nie potwierdzono, jak OpenCode zachowuje role instructions, tools, permissions i lifecycle przy wariantach agenta.
7. Nie potwierdzono minimalnej wydanej wersji Codex ani działania ścieżki `updated_input` w binarium.
8. Nie ustalono publicznego formatu konfiguracji ani granicy między configiem caller i środowiskiem.
9. Trzeba potwierdzić możliwość skorelowania delegacji z kolejnymi requestami bez nowej bazy danych i bez skanowania dowolnej historii promptu.

Domyślna diagnostyka MOŻE zawierać nazwę adaptera, identyfikator korelacyjny, wybrany identyfikator modelu i kod decyzji. NIE MOŻE zawierać promptów, wyników narzędzi, treści odpowiedzi ani wartości nagłówków autoryzacji.

Te luki blokują deklarację `implemented` dla odpowiedniej ścieżki. Jawny błąd jest wymaganym zachowaniem awaryjnym, nie zamiennikiem działającej integracji. Wersję klienta można oznaczyć jako wspieraną dopiero po zaliczeniu jej scenariuszy akceptacyjnych.

## Alternatywy i decyzje

### Własny agent loop

Odrzucone. Dublowałoby natywne narzędzia, uprawnienia, UI i lifecycle, które projekt ma zachować.

### Wybór tylko przez natywne pole modelu

Odrzucone. Nie wystarcza dla przypadku, w którym `clientModel` dziedziczy się w fork, lecz request musi zostać wysłany do innego `upstreamModel`.

### Opcjonalny proxy po wdrożeniu

Odrzucone. Routing przed bramą jest częścią zakresu, a embed musi użyć handlera bez dodatkowego procesu.

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

1. Parent używa modelu A, a równoczesne dzieci używają modeli B i C. Kontrolowana brama potwierdza rzeczywiście odebrane `upstreamModel` dla każdego requestu.
2. Test używa dowolnych opaque identifiers i po zmianie endpointu bramy nie dodaje gałęzi routingu po vendorze.
3. Dziecko wywołuje narzędzie, otrzymuje jego wynik i zwraca poprawnie zdekodowaną odpowiedź końcową. Deklaracja modelu o własnej nazwie nie jest dowodem właściwego routingu.
4. Parent pozostaje niezmieniony, gdy marker jest tylko cytowany w historii.
5. Zagnieżdżone dzieci i niezależne równoległe sesje nie mają wycieku decyzji ani stanu.
6. Fork z odziedziczonym `clientModel` i odmiennym `upstreamModel` jest sprawdzony osobno przez kontrolowaną bramę.
7. Dla wspieranej wersji klienta wieloturowa praca dziecka, resume i compaction zachowują jego wybór modelu. Oddzielne testy utraty informacji o trasie wymagają błędu przed wywołaniem upstream. Sam błąd `unsupported` nie zalicza scenariusza działającej integracji.
8. Nieznany, niejednoznaczny albo niedozwolony target rozpoznanego dziecka objętego routingiem powoduje błąd bez wywołania bramy. Obcy lub cytowany marker rodzica, również z nieznanym modelem, nie uruchamia tej walidacji i nie blokuje jego requestu.
9. Cancellation i stream backpressure przechodzą przez handler bez zmiany semantyki.
10. Core buduje i działa w środowisku bez zależności Bun-only.
11. Testy fake gateway są hermetyczne i stanowią pierwszą linię walidacji.
12. Opt-in testy realnych harnessów działają przeciw zewnętrznej bramie, nie przechowują sekretów i raportują wersje harnessów.

## Strategia testów

[assumption] Warstwy testów powinny oddzielać deterministyczny core, HTTP handler i adaptery harnessów.

- Testy core sprawdzają katalog, priorytet decyzji, allowlist, konflikty markerów, brak fallbacku i izolację sesji.
- Testy handlera z fake gateway przechwytują request, `upstreamModel`, body bez markera, anulowanie i backpressure.
- Testy adaptera potwierdzają przekazanie wiarygodnego kontekstu dziecka oraz jawny błąd na nieobsługiwanej ścieżce.
- Testy E2E są opt-in, nie zapisują sekretów i raportują wersję harnessu oraz bramy.

Sukces E2E wymaga zarówno capture z kontrolowanej bramy, jak i znaczącego, zdekodowanego roundtripu narzędzia dziecka oraz wyniku końcowego. Sam tekst odpowiedzi modelu nie wystarcza.

## Related

- [Indeks dokumentacji](../../README.md)
- [Konwencje dokumentacji](../../CONVENTIONS.md)
- [CCR, pinned commit `c49733678660f726540fca3fff20bbd7d6cab032`](https://github.com/kolezka/claude-code-router/tree/c49733678660f726540fca3fff20bbd7d6cab032)
- [Claude Code sub-agents documentation](https://code.claude.com/docs/en/sub-agents)
- [OpenCode, pinned commit `337fd144d2ba144743368f78d9579a99cce175bd`](https://github.com/anomalyco/opencode/tree/337fd144d2ba144743368f78d9579a99cce175bd)
- [Codex, pinned commit `ac192cd7937b0d73edc6dffe009940ae53782dd4`](https://github.com/openai/codex/tree/ac192cd7937b0d73edc6dffe009940ae53782dd4)
