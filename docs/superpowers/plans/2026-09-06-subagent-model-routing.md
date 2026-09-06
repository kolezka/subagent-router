# Routing modeli subagentów Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`. Wykonuj zadania z checkboxami, każdy cykl TDD zakończ przeglądem zgodności ze specyfikacją i jakości. Tryb wykonania został wybrany przez użytkownika; nie pytaj ponownie o alternatywny workflow.

**Goal:** Wdrożyć mały pakiet Bun i TypeScript routujący modele natywnych subagentów, z odkrywaniem katalogu, niezmienionymi definicjami agentów i CLI do inspekcji.

**Architecture:** Czysty rdzeń podejmuje decyzję na podstawie niezmiennej pary config/snapshot. Oddzielne moduły zapewniają atomowy zapis, odkrywanie katalogu i adaptery klientów. Claude Code używa markera oraz handlera HTTP; OpenCode i Codex używają natywnego modelu z walidacją runtime.

**Tech Stack:** TypeScript strict, Bun 1.3.11, `bun:test`, Web Crypto oraz standardowe Request/Response/ReadableStream. Wbudowane parsery Bun dla YAML i TOML są ograniczone do warstwy adapterów. Rdzeń nie ma zależności runtime ani importów Bun. Deklaracje typów generuje TypeScript.

**Spec:** [Routing modeli subagentów, rewizja 3](../specs/2026-09-06-subagent-model-routing-design.md), baza Git `721ca0065c94ee5b1e5fa7b765b464f3f5e6201c`.

Date: 2026-09-06

Status: draft planu, do przeglądu; wykonanie nie rozpoczęte.

Użytkownik zlecił przygotowanie planu na bazie specyfikacji. Nie jest to polecenie uruchomienia implementacji, płatnych testów ani publikacji paczki. Spec pozostaje nadrzędnym kontraktem; plan nie zmienia jej statusu ani zakresu.

## Global Constraints

- Pakiet MUSI być pojedynczym pakietem Bun + TypeScript, bez monorepo.
- Core MUSI być czysty i importowalny bez obowiązkowego procesu serwera.
- Core NIE MOŻE zależeć od SDK harnessów.
- Bun jest dozwolony w CLI i trybie standalone, ale core NIE MOŻE wymagać API specyficznego dla Bun.
- Projekt NIE MOŻE tworzyć własnego agent loop, MCP runnera, schedulera, UI ani bazy danych.
- Projekt NIE OBEJMUJE auth kont dostawców, translacji protokołów, provider-specific discovery ani automatycznego fallbacku do innego modelu.
- Żadna komenda NIE MOŻE automatycznie zmienić natywnych plików harnessu. Eksport zapisuje tylko do odrębnego katalogu artefaktów, nigdy do katalogu źródłowego agentów, także przy `--force`.
- Natywne definicje agentów, w tym `model: inherit`, MUSZĄ pozostać niezmienione.
- Upstream IDs i aliasy są porównywane case-sensitive. Upstream ID NIE MOŻE być przycinany, normalizowany ani wyprowadzany z aliasu. Nazwę roli dostarcza natywny resolver.
- Alias markera: `^[A-Za-z][A-Za-z0-9_-]{0,126}$`; alias automatyczny: `m-` i pełny SHA-256 UTF-8 dokładnego ID.
- Składnia markerów: `<subagent-router v="1" model="ALIAS"/>` oraz `<subagent-router v="1" role="NAME" agent="AGENT_ID" token="HMAC"/>`. Warianty są rozłączne.
- `subagent-router.json` jest plikiem operatora. `models.lock.json` to snapshot obok niego, ze stanami `available` i `missing`.
- `sourceFingerprint`: SHA-256 UTF-8 zwartej tablicy JSON `[sourceId, effectiveGatewayUrl, effectiveModelsUrl]`. Bazowe URL odrzucają userinfo, query i fragment. Parametr stronicowania dodaje dopiero discovery.
- Kolejność wyboru: jawny model, domyślny model roli, globalny domyślny model dzieci. Niepoprawny jawny wybór nie przechodzi do wartości domyślnej.
- Brak wyboru dla rozpoznanego dziecka oznacza `missing-selection`, chyba że operator jawnie wybrał `inherit` i `unmarkedSubagentAcknowledged: true`.
- Snapshot i config instancji `serve` są niezmienne. Sync lub edycja opisu nie przełącza bieżących sesji.
- `modelSource`: domyślnie `/v1/models`, `timeoutMs: 10000`, `fetchLimit: 1000`, `staleAfterSeconds: 86400`. Nieudane lub częściowe pobranie nie zastępuje poprzedniego snapshotu.
- Pusta lista wymaga `--allow-empty`. Discovery obsługuje `has_more` i `next_cursor`, wykrywa cykle i nie przekazuje credentials między originami.
- Inspekcja i preview są offline. `doctor --connect` i `models sync` jawnie wykonują sieć; transport `serve` ma własny zakres.
- CLI: exit `0` sukces, `1` błąd operacyjny, `2` błędne użycie/config/wybór. `--json` daje dane na stdout, diagnostykę na stderr. Sekrety i niezaufane znaki sterujące nie mogą wyciekać.
- Wersje bazowe ze spec: Claude Code 2.1.263, OpenCode 1.18.29, Codex co najmniej rust-v0.153.4, Bun 1.3.11. Sama wersja nie zalicza testu kompatybilności.
- Fork nie jest gwarancją pierwszego wydania według D3, ale wymaga pomiaru M4 i osobnego przypadku. Nie wolno utożsamiać go ze zwykłym agentem z `model: inherit`.
- Wszystkie pliki tymczasowe i izolowane config roots testów powstają pod wskazanym katalogiem roboczym testów. Przykłady nie dotykają prawdziwego HOME operatora.

---

## Zakres dowodów i polecenia

W chwili pisania planu repozytorium na wskazanej bazie zawiera dokumentację, bez `src`, `tests` i `package.json`. Odczytano śledzone pliki i czysty status Git. [verified]

Na maszynie przygotowującej plan odczytano Bun 1.3.11 i Node v22.23.2. W Bun uruchomiono parsowanie syntetycznych dokumentów `name` i `model: inherit` przez `Bun.YAML.parse` oraz `Bun.TOML.parse`, otrzymując oczekiwane obiekty. To potwierdza obecność parserów, nie poprawność przyszłego resolvera agentów. [verified]

Kod w zadaniach jest materiałem planu, nie wdrożoną aplikacją. Oczekiwany wynik RED lub GREEN jest warunkiem, który wykonawca ma zaobserwować, nie raportem wykonanego testu. Kontrola składni bloków nie zastępuje typechecku, testów ani rzeczywistego wywołania klienta.

Komendy `bun test`, `bun run typecheck` i `bun run build` w zadaniach uruchamia się z głównego katalogu worktree implementacyjnego. Skrypty projektu powstają w Task 1. Zależności developerskie zapisuje się w `bun.lock`; CI używa `bun install --frozen-lockfile`. Nie instalować globalnie narzędzi ani nie zmieniać działającego profilu operatora.

## Rozstrzygnięcia integracyjne planu

1. **Walidacja OpenCode jest bramką, nie generatorem.** Wymaganie 33 wymusza kontrolę runtime. D5 nazywa plugin opcjonalnym, ale sam eksport nie może wymusić allowlist. Task 10 projektuje guard walidujący wybrany wariant bez zmiany argumentów Task. Jeżeli pomiary nie potwierdzą takiego zaczepienia, adapter tej wersji pozostaje `unsupported`; nie zastępuj kontroli zaufaniem do instrukcji modelu.
2. **Profil nie powstaje z numeru wersji ani wyglądu ID.** M1 wymaga dowodu stabilnej tożsamości i jej generowania. Kilka różnych ciągów o długości 64 bitów nie dowodzi losowości. Brak dowodu utrzymuje korelację wyłączoną. Pozostałe niezależne zadania można nadal wykonywać.
3. **RED to porażka zachowania.** Po napisaniu testu można dodać wyłącznie eksportowany, type-correct pusty szkielet, aby import nie był przyczyną porażki. Potem uruchom asercję. Nie uznawaj błędu importu, składni ani konfiguracji test runnera za RED danej funkcji.
4. **Błąd nie zalicza działającej integracji.** Test odmowy nie uprawnia do oznaczenia całego klienta jako wspieranego. Finalna bramka wymaga requestu odebranego przez kontrolowaną bramę, roundtripu narzędzia i zdekodowanego wyniku dziecka.
5. **Zapis współbieżny ma jawny zakres.** Wszystkie komendy routera współdzielą blokadę per config i sprawdzają oba wejściowe hashe pod blokadą. Zewnętrzny edytor, który nie stosuje blokady, jest wykrywany przy ponownym sprawdzeniu, ale nie obiecujemy transakcji z dowolnym procesem systemu plików. Zapis configu i snapshotu jednocześnie nie jest publiczną operacją.
6. **Wiedza o natywnej precedencji jest wersjonowana.** Kolejność katalogów i nazwy ról pochodzą z potwierdzonego profilu resolvera lub dostarczonego native inventory. Nie wprowadzaj uniwersalnego domyślnego porządku na podstawie nazwy pliku. Niepełny wynik offline jest jawnie `files-only`, a skuteczna nazwa bez dowodu jest nierozstrzygnięta.

Koszt tych rozstrzygnięć: część adapterów może pozostać niewłączona po zakończeniu niezależnych modułów, dopóki ich pomiary nie przejdą. Nie usuwa to adapterów, pomiarów ani kryteriów ze zakresu planu.

## File Structure

Docelowe pliki poniżej jeszcze nie istnieją. Pole `Files` każdego zadania wskazuje właściciela ich utworzenia; zadania późniejsze zmieniają wspólne pliki tylko tam, gdzie jest to zapisane.

```text
package.json
bun.lock
tsconfig.json
src/
  index.ts
  bun.ts
  core/
    types.ts
    errors.ts
    hash.ts
    config.ts
    catalog.ts
    route.ts
  io/
    environment.ts
    store.ts
  catalog/
    discovery.ts
    sync.ts
  agents/
    inventory.ts
    claude-code.ts
    opencode.ts
    codex.ts
    export.ts
  adapters/
    capabilities.ts
    claude-code.ts
    markers.ts
    correlation.ts
    opencode.ts
    codex.ts
  transport/
    handler.ts
    hooks.ts
  cli/
    args.ts
    output.ts
    read.ts
    main.ts
    write.ts
    serve.ts
scripts/build.ts
tests/
  support/{fixtures.ts,capture-gateway.ts}
  core/
  io/
  catalog/
  agents/
  adapters/
  transport/
  cli/
  fixtures/{agents,capabilities}/
  probes/{run.ts,evidence.test.ts}
  e2e/{routing.test.ts,cli-workflow.test.ts}
  package.test.ts
docs/
  core/
  catalog/
  agents/
  transport/
  cli/
```

Docelowe dokumenty działających bloków to `README.md`, `CONTRACTS.md`, `INVARIANTS.md`, `GAPS.md` i `OPERATIONS.md`. Powstają dopiero przy Task 15, z rzeczywistym zakresem dowodów, nie jako wcześniejsze deklaracje wdrożenia.

## Zależności i kolejność

| Task | Dostarcza | Wymaga |
|---|---|---|
| 1 | Typy, test harness, aliasy i fixtures | baza dokumentacji |
| 2 | Config, źródło i effective catalogue | 1 |
| 3 | Czyste decyzje routingu | 1, 2 |
| 4 | Zapis i odczyt ze sprawdzaniem konfliktów | 1, 2 |
| 5 | Discovery oraz synchronizacja snapshotu | 1, 2, 4 |
| 6 | Inventory natywnych agentów | 1, 2 |
| 7 | Capture gateway, dowody i profile możliwości | 1, 2, 6 |
| 8 | Markery Claude, katalog narzędzi i korelacja | 1, 2, 3, 7 |
| 9 | Handler HTTP i lokalne hooki Claude | 1, 2, 3, 7, 8 |
| 10 | Warianty i walidacja OpenCode | 1, 2, 3, 6, 7 |
| 11 | Hook walidujący Codex | 1, 2, 3, 6, 7 |
| 12 | Read-only CLI, preview i diagnostyka | 1, 2, 3, 4, 6, 7 |
| 13 | Komendy zapisujące, eksport i serve | 4, 5, 6, 9, 10, 11, 12 |
| 14 | Paczka, import Node i smoke CLI | 1-13 |
| 15 | Pełna bramka integracji i dokumentacja | 1-14 |

Wykonuj kolejno. Autorzy dokumentu mogą przygotowywać rozłączne części równolegle; implementerzy nie mogą równolegle mutować tego samego worktree.

## Protokół Superpowers i rejestr postępu

Wybrana metoda: `superpowers:subagent-driven-development`, nie Workflow i nie jedno duże wykonanie inline.

- Przed wykonaniem: worktree przez `superpowers:using-git-worktrees`; odczytaj plan i spec.
- Rozwiąż katalog tego planu przez zainstalowany skrypt `scripts/sdd-workspace PLAN_FILE` skillu, uruchomiony z rootu właściwego worktree. Helper korzysta z bieżącego repozytorium, nie wyprowadza go ze ścieżki planu. Nie zakładaj ścieżki cache konkretnej maszyny i nie uruchamiaj go w repo CCR. Helper nie może dotknąć katalogu innego planu.
- Pierwszy wiersz ledgeru identyfikuje ten plan. Po wznowieniu przeczytaj ledger i Git przed uruchomieniem kolejnego implementera. Nie powtarzaj zadań oznaczonych complete.
- Dla każdego Task zapisz BASE i użyj `scripts/task-brief PLAN_FILE N`. Świeży implementer otrzymuje własny brief, potrzebne interfejsy poprzedników oraz ścieżkę raportu. Nie dziedziczy całej rozmowy i nie deleguje dalej.
- Każdy podprzypadek przechodzi RED, GREEN i REFACTOR. W raporcie są polecenia, status wyjścia, istotna asercja RED i wynik GREEN. Nie commituj czerwonych testów jako ukończonego zadania.
- Po zadaniu użyj `scripts/review-package PLAN_FILE BASE HEAD`. Reviewer dostaje brief, raport i pakiet diffu. Musi zwrócić osobne oceny zgodności ze spec i jakości.
- Uwagi wracają do implementera. Nie zastępuj review samodzielną poprawką koordynatora. Prowadź pętlę zgodnie z załadowanym skillem, z jawnie zapisanymi rozstrzygnięciami.
- Minimum modelu: Terra lub podobny worker dla dobrze opisanej implementacji; Sol dla współbieżności, auth i trudniejszych przeglądów. Dla końcowego przeglądu całej gałęzi użyj silnego niezależnego modelu. Każdy prompt subagenta zaczyna się właściwym tagiem CCR, a wybrany model jest jawny.
- Przed oznaczeniem zadania complete koordynator sprawdza faktyczne commity i artefakty, nie tylko deklarację implementera.
- Po Task 15 szeroki przegląd całej gałęzi, weryfikacja pozostałych uwag i podsumowanie rozstrzygnięć. Merge, push i publikacja paczki nie są automatycznym krokiem planu.

Przed implementacją wykonaj tabelę preflight z parą producer/consumer dla każdego współdzielonego pliku i interfejsu. W ledgerze zapisuj statusy `pending`, `red-observed`, `green-observed`, `review`, `complete` oraz `blocked` z rzeczywistą przyczyną. Zgoda na przygotowanie planu nie oznacza zaliczenia któregokolwiek z tych etapów.

---

## Zadania

Kod w blokach poniżej jest projektem, nie uruchomionym ani sprawdzonym typami artefaktem. Każdy krok RED musi kończyć się porażką asercji, nie błędem importu. Po napisaniu testu wolno dodać wyłącznie eksportowany, type-correct pusty szkielet, żeby test doszedł do asercji.

### Task 1: Typy publiczne, narzędzia projektu i deterministyczne aliasy

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/core/types.ts`
- Create: `src/core/errors.ts`
- Create: `src/core/hash.ts`
- Create: `tests/support/fixtures.ts`
- Test: `tests/core/hash.test.ts`

**Interfaces:**
- Consumes: nic. Baza repozytorium zawiera tylko dokumentację.
- Produces: wszystkie typy z bloku poniżej, `RouterError`, `sha256(text: string): Promise<string>`, `modelAlias(id: string): Promise<string>`, `sourceFingerprint(sourceId: string, gatewayUrl: string, modelsUrl: string): Promise<string>`, `configFixture(patch?: Partial<OperatorConfig>): OperatorConfig`, `snapshotFixture(ids?: readonly string[]): Promise<CatalogSnapshot>`.

- [ ] **Step 1: Utwórz manifest i konfigurację TypeScript**

```json
{
  "name": "subagent-router",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "engines": { "bun": ">=1.3.11" },
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "build": "bun run scripts/build.ts"
  },
  "devDependencies": {
    "@types/bun": "1.3.11",
    "typescript": "5.9.2"
  }
}
```

Wersje devDependencies są wartościami startowymi. Wykonawca ustala je poleceniem `bun add -d typescript @types/bun` i zapisuje wynik w `bun.lock`. Nie wolno dopisywać zależności runtime do `dependencies` w tym zadaniu.

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM"],
    "types": ["bun-types"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "declaration": true,
    "emitDeclarationOnly": true,
    "outDir": "dist/types",
    "rootDir": "src"
  },
  "include": ["src", "tests", "scripts"]
}
```

`lib` zawiera `DOM` wyłącznie dla typów `Request`, `Response` i `crypto.subtle`. Rdzeń nie może używać API przeglądarki poza tymi standardowymi obiektami.

- [ ] **Step 2: Zapisz typy publiczne w jednym pliku**

Plik `src/core/types.ts` jest jedynym źródłem typów współdzielonych przez zadania. Kolejne zadania importują stąd, nie definiują własnych kopii.

```ts
export type ClientId = 'claude-code' | 'opencode' | 'codex';
export type Env = Readonly<Record<string, string | undefined>>;
export type HeaderMap = Readonly<Record<string, string>>;
export type FetchLike = (request: Request) => Promise<Response>;

export interface ModelOverride {
  alias?: string;
  description?: string;
  enabled?: boolean;
  clientModel?: string;
}

export interface OperatorConfig {
  version: 1;
  modelSource: {
    sourceId: string;
    baseUrlEnv: string;
    endpointPath: string;
    authEnv?: string;
    headersEnv: string[];
    timeoutMs: number;
    fetchLimit: number;
    staleAfterSeconds: number;
  };
  modelOverrides: Record<string, ModelOverride>;
  roles: Record<string, { routeOverride: string }>;
  defaults: {
    child: string | null;
    unmarkedSubagent: 'error' | 'inherit';
    unmarkedSubagentAcknowledged?: boolean;
  };
  agentRoots: Record<ClientId, { configRoot: string | null }>;
  gateway: { urlEnv: string; headersEnv: string[] };
  harness: {
    claudeCode: { correlation: 'auto' | 'off'; secretEnv: string };
    opencode: { providerId: string };
    codex: { emitModelCatalog: boolean };
  };
}

export interface SnapshotModel {
  id: string;
  alias: string;
  status: 'available' | 'missing';
  metadata: { displayName?: string };
}

export interface CatalogSnapshot {
  version: 1;
  sourceId: string;
  sourceFingerprint: string;
  fetchedAt: string;
  models: SnapshotModel[];
}

export interface ResolvedModel {
  id: string;
  alias: string;
  status: 'available' | 'missing';
  enabled: boolean;
  description?: string;
  clientModel?: string;
}

export interface EffectiveCatalog {
  byId: ReadonlyMap<string, ResolvedModel>;
  byAlias: ReadonlyMap<string, ResolvedModel>;
}

export type RouteErrorCode =
  | 'unknown-model'
  | 'model-not-allowed'
  | 'invalid-marker'
  | 'conflicting-markers'
  | 'correlation-conflict'
  | 'unsupported-path'
  | 'missing-selection';

export type RouteDecision =
  | { kind: 'pass-through'; reason: 'parent' | 'inherit-allowed'; ignoredMarkers: number }
  | {
      kind: 'route';
      upstreamModel: string;
      clientModel?: string;
      source: 'explicit' | 'role-default' | 'global-default' | 'correlated';
      ignoredMarkers: number;
    }
  | { kind: 'error'; code: RouteErrorCode; ignoredMarkers: number };

export interface RouteInput {
  client: ClientId;
  scope: 'parent' | 'child';
  role?: string;
  explicitIds: readonly string[];
  roleDefaultId?: string;
  correlatedId?: string;
  markerError?: 'invalid-marker' | 'conflicting-markers';
  clientModel?: string;
  ignoredMarkers: number;
}

export interface AgentDefinition {
  client: ClientId;
  name: string;
  scope: string;
  path?: string;
  declaredModel?: string;
  hidden: boolean;
  body?: string;
  native: Readonly<Record<string, unknown>>;
  availability: 'available' | 'missing' | 'fileless';
  shadowed: boolean;
}

export interface AgentInventory {
  entries: readonly AgentDefinition[];
  completeness: 'files-only' | 'native';
  diagnostics: readonly string[];
}

export interface ResolverOptions {
  cwd: string;
  home: string;
  env: Env;
  configRoot?: string;
  additionalRoots: readonly string[];
  nativeInventory?: AgentInventory;
}

export interface SourceContext {
  sourceId: string;
  effectiveGatewayUrl: string;
  effectiveModelsUrl: string;
  headers: HeaderMap;
}

export interface LoadedState {
  config: OperatorConfig;
  snapshot?: CatalogSnapshot;
  expected: { configHash: string; snapshotHash: string | null };
  generation: string;
}

export interface SyncResult {
  snapshot: CatalogSnapshot;
  added: string[];
  changed: string[];
  missing: string[];
}

export interface CapabilityProfile {
  client: ClientId;
  version: string;
  status: 'pending' | 'supported' | 'unsupported';
  correlation: boolean;
  fork: boolean;
  probes: Readonly<Record<string, 'passed' | 'failed' | 'pending'>>;
}

export interface CliDeps {
  cwd: string;
  home: string;
  env: Env;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  isTTY: boolean;
  fetch: FetchLike;
  now: () => Date;
}

export interface ExportFile {
  relativePath: string;
  content: string;
}
```

- [ ] **Step 3: Zapisz klasę błędu**

```ts
export class RouterError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RouterError';
    this.code = code;
  }
}
```

Komunikat nie może zawierać wartości nagłówków, tokenów ani treści promptów. Zadania, które tworzą błędy z danymi wejściowymi, przekazują tylko identyfikatory i nazwy pól.

- [ ] **Step 4: Napisz failing test aliasów i fingerprintu**

Wartości oczekiwane policzono ręcznie poza kodem projektu: SHA-256 UTF-8 ciągu `gateway/fast-worker` oraz SHA-256 zwartej tablicy JSON `["primary-gateway","https://gateway.example/v1","https://gateway.example/v1/models"]`. Są to te same literały, które podaje przykład snapshotu w spec.

```ts
import { describe, expect, test } from 'bun:test';
import { modelAlias, sha256, sourceFingerprint } from '../../src/core/hash';

describe('hash', () => {
  test('sha256 zwraca 64 znaki hex dla pustego ciągu', async () => {
    expect(await sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  test('modelAlias buduje prefiks m- i pełny hash dokładnego ID', async () => {
    expect(await modelAlias('gateway/fast-worker')).toBe(
      'm-6414d01405c95a7bd2b2a13b415d7685a1673f800ca90dd031a5eeb1776dc81d',
    );
  });

  test('modelAlias rozróżnia wielkość liter i spacje w ID', async () => {
    const lower = await modelAlias('gateway/model');
    const upper = await modelAlias('gateway/Model');
    const spaced = await modelAlias('gateway/model ');
    expect(new Set([lower, upper, spaced]).size).toBe(3);
  });

  test('sourceFingerprint haszuje zwartą tablicę JSON trzech elementów', async () => {
    expect(
      await sourceFingerprint('primary-gateway', 'https://gateway.example/v1', 'https://gateway.example/v1/models'),
    ).toBe('96b80377b311dc1765bde8e0ec7bae4efa848497ad0245cfb927653ba2d0527b');
  });
});
```

- [ ] **Step 5: Dodaj pusty szkielet i uruchom test, żeby zaobserwować RED**

Szkielet w `src/core/hash.ts` zwraca pusty ciąg z każdej funkcji. Uruchom:

```bash
bun test ./tests/core/hash.test.ts
```

Oczekiwane: 4 testy padają na asercjach `toBe`, na przykład `Expected: "m-6414d0..." Received: ""`. Jeżeli test pada na braku modułu, wróć do szkieletu.

- [ ] **Step 6: Zaimplementuj hash przez Web Crypto**

```ts
const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return toHex(digest);
}

export async function modelAlias(id: string): Promise<string> {
  return `m-${await sha256(id)}`;
}

export async function sourceFingerprint(sourceId: string, gatewayUrl: string, modelsUrl: string): Promise<string> {
  return sha256(JSON.stringify([sourceId, gatewayUrl, modelsUrl]));
}
```

`JSON.stringify` tablicy bez odstępów daje dokładnie zwartą postać wymaganą przez spec. Nie używaj `Bun.hash` ani `node:crypto`, bo rdzeń musi działać w każdym środowisku z Web Crypto.

- [ ] **Step 7: Uruchom test i zaobserwuj GREEN**

```bash
bun test ./tests/core/hash.test.ts
```

Oczekiwane: 4 pass, 0 fail.

- [ ] **Step 8: Napisz wspólne fixtures**

```ts
import type { CatalogSnapshot, OperatorConfig } from '../../src/core/types';
import { modelAlias, sourceFingerprint } from '../../src/core/hash';

export const FIXTURE_SOURCE_ID = 'test-gateway';
export const FIXTURE_GATEWAY_URL = 'http://127.0.0.1:8000/v1';
export const FIXTURE_MODELS_URL = 'http://127.0.0.1:8000/v1/models';
export const FIXTURE_FETCHED_AT = '2026-09-06T00:00:00.000Z';
export const FIXTURE_MODEL_ID = 'gateway/fast-worker';

export function configFixture(patch: Partial<OperatorConfig> = {}): OperatorConfig {
  const base: OperatorConfig = {
    version: 1,
    modelSource: {
      sourceId: FIXTURE_SOURCE_ID,
      baseUrlEnv: 'GATEWAY_URL',
      endpointPath: '/v1/models',
      authEnv: 'MODELS_AUTH',
      headersEnv: ['GATEWAY_HEADERS'],
      timeoutMs: 10000,
      fetchLimit: 1000,
      staleAfterSeconds: 86400,
    },
    modelOverrides: {
      [FIXTURE_MODEL_ID]: { alias: 'fast', description: 'Szybkie zadania.', enabled: true, clientModel: 'haiku' },
    },
    roles: { 'claude-code:explorer': { routeOverride: FIXTURE_MODEL_ID } },
    defaults: { child: null, unmarkedSubagent: 'error' },
    agentRoots: {
      'claude-code': { configRoot: null },
      opencode: { configRoot: null },
      codex: { configRoot: null },
    },
    gateway: { urlEnv: 'GATEWAY_URL', headersEnv: ['GATEWAY_HEADERS'] },
    harness: {
      claudeCode: { correlation: 'auto', secretEnv: 'ROUTER_SECRET' },
      opencode: { providerId: 'gateway' },
      codex: { emitModelCatalog: false },
    },
  };
  return structuredClone({ ...base, ...patch });
}

export async function snapshotFixture(ids: readonly string[] = [FIXTURE_MODEL_ID]): Promise<CatalogSnapshot> {
  const models = await Promise.all(
    ids.map(async (id) => ({ id, alias: await modelAlias(id), status: 'available' as const, metadata: {} })),
  );
  return {
    version: 1,
    sourceId: FIXTURE_SOURCE_ID,
    sourceFingerprint: await sourceFingerprint(FIXTURE_SOURCE_ID, FIXTURE_GATEWAY_URL, FIXTURE_MODELS_URL),
    fetchedAt: FIXTURE_FETCHED_AT,
    models,
  };
}
```

Każde wywołanie zwraca świeżą kopię. Test, który mutuje fixture, nie może wpływać na inne testy.

- [ ] **Step 9: Uruchom typecheck i cały zestaw**

```bash
bun run typecheck && bun test
```

Oczekiwane: brak błędów typów, 4 pass.

- [ ] **Step 10: Commit**

```bash
git add package.json bun.lock tsconfig.json src/core tests
git commit -m "feat: add core types, hashing and test fixtures"
```

### Task 2: Walidacja konfiguracji, snapshotu i effective catalogue

**Files:**
- Create: `src/core/config.ts`
- Create: `src/core/catalog.ts`
- Create: `src/io/environment.ts`
- Test: `tests/core/config.test.ts`
- Test: `tests/core/catalog.test.ts`
- Test: `tests/io/environment.test.ts`

**Interfaces:**
- Consumes: typy i `RouterError` z Task 1, `sourceFingerprint`, fixtures.
- Produces: `parseOperatorConfig(value: unknown): OperatorConfig`, `parseSnapshot(value: unknown): CatalogSnapshot`, `buildCatalog(config: OperatorConfig, snapshot: CatalogSnapshot): EffectiveCatalog`, `resolveModel(ref: string, catalog: EffectiveCatalog): ResolvedModel`, `resolveSource(config: OperatorConfig, env: Env): SourceContext`, `validateSource(source: SourceContext, snapshot: CatalogSnapshot): Promise<void>`.

- [ ] **Step 1: Napisz failing testy walidacji konfiguracji**

```ts
import { describe, expect, test } from 'bun:test';
import { parseOperatorConfig, parseSnapshot } from '../../src/core/config';
import { RouterError } from '../../src/core/errors';
import { configFixture, snapshotFixture } from '../support/fixtures';

function expectCode(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(RouterError);
  expect((caught as RouterError).code).toBe(code);
}

describe('parseOperatorConfig', () => {
  test('przyjmuje poprawny plik i zwraca kopię', () => {
    const input = configFixture();
    const parsed = parseOperatorConfig(input);
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
  });

  test.each([
    ['nieznana wersja', { version: 2 }, 'config-version'],
    ['nieznane pole', { extra: true }, 'config-unknown-field'],
    ['inline header', { gateway: { urlEnv: 'GATEWAY_URL', headersEnv: ['Authorization: Bearer x'] } }, 'config-inline-header'],
    ['inherit bez potwierdzenia', { defaults: { child: null, unmarkedSubagent: 'inherit' } }, 'config-inherit-unacknowledged'],
    ['zły alias', { modelOverrides: { 'gateway/fast-worker': { alias: '9bad' } } }, 'config-alias-syntax'],
    ['zła nazwa roli', { roles: { explorer: { routeOverride: 'gateway/fast-worker' } } }, 'config-role-name'],
  ])('odrzuca: %s', (_name, patch, code) => {
    expectCode(() => parseOperatorConfig({ ...configFixture(), ...(patch as object) }), code);
  });
});

describe('parseSnapshot', () => {
  test('odrzuca duplikat ID', async () => {
    const snapshot = await snapshotFixture(['a', 'a']);
    expectCode(() => parseSnapshot(snapshot), 'snapshot-duplicate-id');
  });

  test('odrzuca nieznany status', async () => {
    const snapshot = await snapshotFixture(['a']);
    (snapshot.models[0] as { status: string }).status = 'gone';
    expectCode(() => parseSnapshot(snapshot), 'snapshot-schema');
  });
});
```

Nazwa zmiennej środowiskowej w `headersEnv` musi pasować do `^[A-Z][A-Z0-9_]*$`. Wszystko inne jest traktowane jako wartość inline. Klucz roli musi mieć postać `<client>:<name>` z klientem ze zbioru `ClientId`.

- [ ] **Step 2: Dodaj szkielety i zaobserwuj RED**

Szkielet `parseOperatorConfig` zwraca `value as OperatorConfig`, `parseSnapshot` zwraca `value as CatalogSnapshot`.

```bash
bun test ./tests/core/config.test.ts
```

Oczekiwane: test „przyjmuje poprawny plik” pada na `not.toBe` (zwrócono ten sam obiekt), pozostałe padają na `toBeInstanceOf(RouterError)`.

- [ ] **Step 3: Zaimplementuj walidator**

Walidator jest ręczny, bez biblioteki schematów. Każda ścieżka błędu ma stały kod. Kolejność sprawdzeń: `version`, zbiór dozwolonych kluczy na każdym poziomie, typy pól, reguły semantyczne.

```ts
import { RouterError } from './errors';
import type { CatalogSnapshot, ClientId, OperatorConfig } from './types';

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const ALIAS = /^[A-Za-z][A-Za-z0-9_-]{0,126}$/;
const CLIENTS: readonly ClientId[] = ['claude-code', 'opencode', 'codex'];

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RouterError('config-schema', `${path} musi być obiektem`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new RouterError('config-unknown-field', `${path}.${key} nie jest znanym polem`);
    }
  }
}

function envNames(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new RouterError('config-schema', `${path} musi być tablicą`);
  return value.map((item) => {
    if (typeof item !== 'string' || !ENV_NAME.test(item)) {
      throw new RouterError('config-inline-header', `${path} może zawierać tylko nazwy zmiennych środowiskowych`);
    }
    return item;
  });
}

export function parseOperatorConfig(value: unknown): OperatorConfig {
  const root = record(value, 'config');
  if (root.version !== 1) throw new RouterError('config-version', 'obsługiwana jest tylko version 1');
  onlyKeys(root, ['version', 'modelSource', 'modelOverrides', 'roles', 'defaults', 'agentRoots', 'gateway', 'harness'], 'config');
  const source = record(root.modelSource, 'config.modelSource');
  onlyKeys(source, ['sourceId', 'baseUrlEnv', 'endpointPath', 'authEnv', 'headersEnv', 'timeoutMs', 'fetchLimit', 'staleAfterSeconds'], 'config.modelSource');
  const overrides = record(root.modelOverrides, 'config.modelOverrides');
  for (const [id, raw] of Object.entries(overrides)) {
    const override = record(raw, `config.modelOverrides.${id}`);
    onlyKeys(override, ['alias', 'description', 'enabled', 'clientModel'], `config.modelOverrides.${id}`);
    if (override.alias !== undefined && (typeof override.alias !== 'string' || !ALIAS.test(override.alias))) {
      throw new RouterError('config-alias-syntax', `alias modelu ${id} nie spełnia gramatyki markera`);
    }
  }
  const roles = record(root.roles, 'config.roles');
  for (const key of Object.keys(roles)) {
    const [client] = key.split(':');
    if (!key.includes(':') || !CLIENTS.includes(client as ClientId)) {
      throw new RouterError('config-role-name', `rola ${key} musi mieć postać <client>:<name>`);
    }
  }
  const defaults = record(root.defaults, 'config.defaults');
  if (defaults.unmarkedSubagent === 'inherit' && defaults.unmarkedSubagentAcknowledged !== true) {
    throw new RouterError('config-inherit-unacknowledged', 'inherit wymaga unmarkedSubagentAcknowledged: true');
  }
  const gateway = record(root.gateway, 'config.gateway');
  envNames(gateway.headersEnv, 'config.gateway.headersEnv');
  envNames(source.headersEnv, 'config.modelSource.headersEnv');
  return structuredClone(root) as unknown as OperatorConfig;
}

export function parseSnapshot(value: unknown): CatalogSnapshot {
  const root = record(value, 'snapshot');
  if (root.version !== 1) throw new RouterError('snapshot-version', 'obsługiwana jest tylko version 1');
  const models = Array.isArray(root.models) ? root.models : [];
  const seen = new Set<string>();
  for (const raw of models) {
    const model = record(raw, 'snapshot.models[]');
    if (typeof model.id !== 'string' || model.id.length === 0) throw new RouterError('snapshot-schema', 'id modelu musi być niepustym ciągiem');
    if (model.status !== 'available' && model.status !== 'missing') throw new RouterError('snapshot-schema', `status modelu ${model.id} jest nieznany`);
    if (seen.has(model.id)) throw new RouterError('snapshot-duplicate-id', `model ${model.id} występuje dwa razy`);
    seen.add(model.id);
  }
  return structuredClone(root) as unknown as CatalogSnapshot;
}
```

Fragment pokazuje kształt; wykonawca dopisuje kontrolę typów pozostałych pól (`timeoutMs`, `fetchLimit`, `staleAfterSeconds` jako dodatnie liczby całkowite, `agentRoots` z kompletem trzech klientów, `harness` z dozwolonymi wartościami). Każda brakująca kontrola to osobny wiersz w `test.each`.

- [ ] **Step 4: Zaobserwuj GREEN i dopisz brakujące wiersze tabeli**

```bash
bun test ./tests/core/config.test.ts
```

Oczekiwane: wszystkie wiersze pass. Dodaj wiersze dla `timeoutMs: 0`, brakującego klienta w `agentRoots` i `correlation: 'on'`; każdy musi najpierw paść, potem przejść.

- [ ] **Step 5: Napisz failing testy effective catalogue**

```ts
import { describe, expect, test } from 'bun:test';
import { buildCatalog, resolveModel } from '../../src/core/catalog';
import { RouterError } from '../../src/core/errors';
import { FIXTURE_MODEL_ID, configFixture, snapshotFixture } from '../support/fixtures';

describe('buildCatalog', () => {
  test('nakładka nadpisuje alias, a model bez nakładki zachowuje alias m-', async () => {
    const snapshot = await snapshotFixture([FIXTURE_MODEL_ID, 'gateway/other']);
    const catalog = buildCatalog(configFixture(), snapshot);
    expect(catalog.byAlias.get('fast')?.id).toBe(FIXTURE_MODEL_ID);
    expect(catalog.byId.get('gateway/other')?.alias).toBe(snapshot.models[1]?.alias);
    expect(catalog.byId.get('gateway/other')?.description).toBeUndefined();
  });

  test('nakładka dla ID spoza snapshotu nie tworzy modelu', async () => {
    const config = configFixture({ modelOverrides: { 'gateway/ghost': { description: 'x' } } });
    const catalog = buildCatalog(config, await snapshotFixture());
    expect(catalog.byId.has('gateway/ghost')).toBe(false);
  });

  test('missing w snapshotcie daje enabled false nawet z enabled true w nakładce', async () => {
    const snapshot = await snapshotFixture([FIXTURE_MODEL_ID]);
    (snapshot.models[0] as { status: string }).status = 'missing';
    const catalog = buildCatalog(configFixture(), snapshot);
    expect(catalog.byId.get(FIXTURE_MODEL_ID)?.enabled).toBe(false);
  });

  test('kolizja aliasu z ID innego modelu jest błędem', async () => {
    const config = configFixture({ modelOverrides: { 'gateway/a': { alias: 'gateway-b' } } });
    const snapshot = await snapshotFixture(['gateway/a', 'gateway-b']);
    expect(() => buildCatalog(config, snapshot)).toThrow(RouterError);
  });
});

describe('resolveModel', () => {
  test('rozwiązuje po dokładnym ID i po aliasie, ale nie po innej wielkości liter', async () => {
    const catalog = buildCatalog(configFixture(), await snapshotFixture());
    expect(resolveModel(FIXTURE_MODEL_ID, catalog).id).toBe(FIXTURE_MODEL_ID);
    expect(resolveModel('fast', catalog).id).toBe(FIXTURE_MODEL_ID);
    expect(() => resolveModel('Fast', catalog)).toThrow(RouterError);
    expect(() => resolveModel('gateway/Fast-Worker', catalog)).toThrow(RouterError);
  });
});
```

- [ ] **Step 6: Szkielet, RED, implementacja, GREEN**

Szkielet zwraca puste mapy i rzuca `RouterError('unknown-model')`. Uruchom `bun test ./tests/core/catalog.test.ts`, zaobserwuj porażki asercji. Implementacja: dla każdego modelu snapshotu utwórz `ResolvedModel` z aliasem nakładki albo aliasem snapshotu; `enabled` to `status === 'available' && (override.enabled ?? true)`; zbuduj `byAlias` sprawdzając, czy alias nie koliduje z innym aliasem ani z żadnym ID w snapshotcie (`RouterError('config-alias-collision')`). `resolveModel` szuka najpierw w `byId`, potem w `byAlias`, bez normalizacji; brak trafienia rzuca `RouterError('unknown-model')`.

```bash
bun test ./tests/core/catalog.test.ts
```

Oczekiwane: 5 pass.

- [ ] **Step 7: Napisz failing test źródła i fingerprintu**

```ts
import { describe, expect, test } from 'bun:test';
import { RouterError } from '../../src/core/errors';
import { resolveSource, validateSource } from '../../src/io/environment';
import { FIXTURE_GATEWAY_URL, configFixture, snapshotFixture } from '../support/fixtures';

const env = {
  GATEWAY_URL: `${FIXTURE_GATEWAY_URL}/`,
  GATEWAY_HEADERS: JSON.stringify({ 'X-Team': 'router' }),
  MODELS_AUTH: 'secret-token',
};

describe('resolveSource', () => {
  test('usuwa końcowy ukośnik, nie dokleja /v1 dwa razy i dodaje nagłówek auth', () => {
    const source = resolveSource(configFixture(), env);
    expect(source.effectiveGatewayUrl).toBe('http://127.0.0.1:8000/v1');
    expect(source.effectiveModelsUrl).toBe('http://127.0.0.1:8000/v1/models');
    expect(source.headers).toEqual({ 'X-Team': 'router', Authorization: 'Bearer secret-token' });
  });

  test.each([
    ['userinfo', 'http://user:pw@127.0.0.1:8000/v1'],
    ['query', 'http://127.0.0.1:8000/v1?x=1'],
    ['fragment', 'http://127.0.0.1:8000/v1#frag'],
  ])('odrzuca URL z %s', (_label, url) => {
    expect(() => resolveSource(configFixture(), { ...env, GATEWAY_URL: url })).toThrow(RouterError);
  });

  test('zduplikowana nazwa nagłówka niezależnie od wielkości liter jest błędem', () => {
    const headers = JSON.stringify({ authorization: 'x' });
    expect(() => resolveSource(configFixture(), { ...env, GATEWAY_HEADERS: headers })).toThrow(RouterError);
  });

  test('brak zmiennej z URL jest błędem z nazwą zmiennej, bez wartości', () => {
    let message = '';
    try {
      resolveSource(configFixture(), {});
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('GATEWAY_URL');
    expect(message).not.toContain('secret-token');
  });
});

describe('validateSource', () => {
  test('przyjmuje snapshot o zgodnym fingerprincie i odrzuca zmieniony endpoint', async () => {
    const snapshot = await snapshotFixture();
    await validateSource(resolveSource(configFixture(), env), snapshot);
    const moved = resolveSource(configFixture(), { ...env, GATEWAY_URL: 'http://127.0.0.1:9000/v1' });
    await expect(validateSource(moved, snapshot)).rejects.toBeInstanceOf(RouterError);
  });
});
```

- [ ] **Step 8: Szkielet, RED, implementacja, GREEN**

Uruchom `bun test ./tests/io/environment.test.ts` na szkielecie zwracającym puste pola i zaobserwuj porażki asercji. Implementacja `resolveSource`: odczytaj URL ze zmiennej `baseUrlEnv`, sparsuj przez `new URL`, odrzuć `username`, `password`, `search` i `hash` kodem `source-url`; usuń końcowe `/`; `effectiveModelsUrl` powstaje z segmentów: jeśli `endpointPath` zaczyna się od ostatniego segmentu bazy (`/v1`), nie dublować go. Nagłówki: scal obiekty JSON ze wszystkich `headersEnv`, potem `Authorization: Bearer <authEnv>`; kolizja nazw porównywana po `toLowerCase()` rzuca `source-header-conflict`. `validateSource` porównuje `snapshot.sourceId` i `sourceFingerprint(sourceId, effectiveGatewayUrl, effectiveModelsUrl)` ze snapshotem; różnica rzuca `snapshot-source-mismatch`.

```bash
bun test ./tests/io/environment.test.ts
```

Oczekiwane: 7 pass.

- [ ] **Step 9: Refaktor i pełny zestaw**

```bash
bun run typecheck && bun test
```

Oczekiwane: 0 fail. Rdzeń (`src/core`) nie importuje niczego z `src/io`.

- [ ] **Step 10: Commit**

```bash
git add src/core/config.ts src/core/catalog.ts src/io/environment.ts tests/core tests/io
git commit -m "feat: validate operator config, snapshot and gateway source"
```

### Task 3: Deterministyczna decyzja routingu

**Files:**
- Create: `src/core/route.ts`
- Test: `tests/core/route.test.ts`

**Interfaces:**
- Consumes: `RouteInput`, `RouteDecision`, `EffectiveCatalog`, `buildCatalog`, fixtures.
- Produces: `resolveRoute(input: RouteInput, config: OperatorConfig, catalog: EffectiveCatalog): RouteDecision`. Funkcja czysta, bez stanu, bez sieci, bez zegara.

- [ ] **Step 1: Napisz failing test tabelaryczny**

```ts
import { describe, expect, test } from 'bun:test';
import { buildCatalog } from '../../src/core/catalog';
import { resolveRoute } from '../../src/core/route';
import type { RouteDecision, RouteInput } from '../../src/core/types';
import { FIXTURE_MODEL_ID, configFixture, snapshotFixture } from '../support/fixtures';

const OTHER = 'gateway/other';

function child(patch: Partial<RouteInput>): RouteInput {
  return { client: 'claude-code', scope: 'child', explicitIds: [], ignoredMarkers: 0, ...patch };
}

describe('resolveRoute', () => {
  const cases: Array<[string, RouteInput, RouteDecision]> = [
    ['rodzic bez markera', { client: 'claude-code', scope: 'parent', explicitIds: [], ignoredMarkers: 0 }, { kind: 'pass-through', reason: 'parent', ignoredMarkers: 0 }],
    ['rodzic z cytowanym markerem', { client: 'claude-code', scope: 'parent', explicitIds: [], ignoredMarkers: 2 }, { kind: 'pass-through', reason: 'parent', ignoredMarkers: 2 }],
    ['jawny wybór wygrywa z rolą', child({ explicitIds: [OTHER], roleDefaultId: FIXTURE_MODEL_ID }), { kind: 'route', upstreamModel: OTHER, source: 'explicit', ignoredMarkers: 0 }],
    ['rola bez jawnego wyboru', child({ role: 'claude-code:explorer', roleDefaultId: FIXTURE_MODEL_ID }), { kind: 'route', upstreamModel: FIXTURE_MODEL_ID, clientModel: 'haiku', source: 'role-default', ignoredMarkers: 0 }],
    ['korelacja bez markera', child({ correlatedId: OTHER }), { kind: 'route', upstreamModel: OTHER, source: 'correlated', ignoredMarkers: 0 }],
    ['jawny wybór zgodny z korelacją', child({ explicitIds: [OTHER], correlatedId: OTHER }), { kind: 'route', upstreamModel: OTHER, source: 'explicit', ignoredMarkers: 0 }],
    ['jawny wybór sprzeczny z korelacją', child({ explicitIds: [FIXTURE_MODEL_ID], correlatedId: OTHER }), { kind: 'error', code: 'correlation-conflict', ignoredMarkers: 0 }],
    ['nieznany jawny model nie spada do roli', child({ explicitIds: ['gateway/none'], roleDefaultId: FIXTURE_MODEL_ID }), { kind: 'error', code: 'unknown-model', ignoredMarkers: 0 }],
    ['dwa różne jawne markery', child({ explicitIds: [OTHER, FIXTURE_MODEL_ID] }), { kind: 'error', code: 'conflicting-markers', ignoredMarkers: 0 }],
    ['niepoprawny marker w autoryzowanej pozycji', child({ markerError: 'invalid-marker', roleDefaultId: FIXTURE_MODEL_ID }), { kind: 'error', code: 'invalid-marker', ignoredMarkers: 0 }],
    ['dziecko bez wskazania', child({}), { kind: 'error', code: 'missing-selection', ignoredMarkers: 0 }],
  ];

  test.each(cases)('%s', async (_name, input, expected) => {
    const catalog = buildCatalog(configFixture(), await snapshotFixture([FIXTURE_MODEL_ID, OTHER]));
    expect(resolveRoute(input, configFixture(), catalog)).toEqual(expected);
  });

  test('globalny default działa tylko bez roli i bez jawnego wyboru', async () => {
    const config = configFixture({ defaults: { child: OTHER, unmarkedSubagent: 'error' } });
    const catalog = buildCatalog(config, await snapshotFixture([FIXTURE_MODEL_ID, OTHER]));
    expect(resolveRoute(child({}), config, catalog)).toEqual({ kind: 'route', upstreamModel: OTHER, source: 'global-default', ignoredMarkers: 0 });
  });

  test('inherit z potwierdzeniem przepuszcza dziecko bez wskazania', async () => {
    const config = configFixture({ defaults: { child: null, unmarkedSubagent: 'inherit', unmarkedSubagentAcknowledged: true } });
    const catalog = buildCatalog(config, await snapshotFixture());
    expect(resolveRoute(child({}), config, catalog)).toEqual({ kind: 'pass-through', reason: 'inherit-allowed', ignoredMarkers: 0 });
  });

  test('model missing albo wyłączony daje model-not-allowed bez fallbacku', async () => {
    const snapshot = await snapshotFixture([FIXTURE_MODEL_ID, OTHER]);
    (snapshot.models[1] as { status: string }).status = 'missing';
    const config = configFixture({ defaults: { child: FIXTURE_MODEL_ID, unmarkedSubagent: 'error' } });
    const catalog = buildCatalog(config, snapshot);
    expect(resolveRoute(child({ explicitIds: [OTHER] }), config, catalog)).toEqual({ kind: 'error', code: 'model-not-allowed', ignoredMarkers: 0 });
  });
});
```

Wartości `clientModel` w wyniku pochodzą z nakładki modelu, a `ignoredMarkers` jest przepisywane z wejścia bez zmian. Wynik `route` zawiera `clientModel` tylko wtedy, gdy nakładka je definiuje; `toEqual` ignoruje pola `undefined`.

- [ ] **Step 2: Szkielet i RED**

Szkielet zwraca zawsze `{ kind: 'error', code: 'unsupported-path', ignoredMarkers: input.ignoredMarkers }`.

```bash
bun test ./tests/core/route.test.ts
```

Oczekiwane: wszystkie przypadki poza żadnym padają na `toEqual`.

- [ ] **Step 3: Zaimplementuj kolejność decyzji**

```ts
import { RouterError } from './errors';
import { resolveModel } from './catalog';
import type { EffectiveCatalog, OperatorConfig, ResolvedModel, RouteDecision, RouteInput } from './types';

function lookup(id: string, catalog: EffectiveCatalog): ResolvedModel | 'unknown' {
  try {
    return resolveModel(id, catalog);
  } catch (error) {
    if (error instanceof RouterError && error.code === 'unknown-model') return 'unknown';
    throw error;
  }
}

export function resolveRoute(input: RouteInput, config: OperatorConfig, catalog: EffectiveCatalog): RouteDecision {
  const ignoredMarkers = input.ignoredMarkers;
  if (input.scope === 'parent') return { kind: 'pass-through', reason: 'parent', ignoredMarkers };
  if (input.markerError) return { kind: 'error', code: input.markerError, ignoredMarkers };
  const explicit = [...new Set(input.explicitIds)];
  if (explicit.length > 1) return { kind: 'error', code: 'conflicting-markers', ignoredMarkers };

  const candidates: Array<[string, RouteDecision extends { source: infer S } ? S : never]> = [];
  if (explicit[0] !== undefined) candidates.push([explicit[0], 'explicit']);
  else if (input.correlatedId !== undefined) candidates.push([input.correlatedId, 'correlated']);
  else if (input.roleDefaultId !== undefined) candidates.push([input.roleDefaultId, 'role-default']);
  else if (config.defaults.child !== null) candidates.push([config.defaults.child, 'global-default']);

  if (explicit[0] !== undefined && input.correlatedId !== undefined && input.correlatedId !== explicit[0]) {
    return { kind: 'error', code: 'correlation-conflict', ignoredMarkers };
  }
  const candidate = candidates[0];
  if (candidate === undefined) {
    if (config.defaults.unmarkedSubagent === 'inherit') return { kind: 'pass-through', reason: 'inherit-allowed', ignoredMarkers };
    return { kind: 'error', code: 'missing-selection', ignoredMarkers };
  }
  const model = lookup(candidate[0], catalog);
  if (model === 'unknown') return { kind: 'error', code: 'unknown-model', ignoredMarkers };
  if (!model.enabled) return { kind: 'error', code: 'model-not-allowed', ignoredMarkers };
  return {
    kind: 'route',
    upstreamModel: model.id,
    ...(model.clientModel !== undefined ? { clientModel: model.clientModel } : {}),
    source: candidate[1],
    ignoredMarkers,
  };
}
```

Typ `source` w kandydatach wykonawca zapisze jako jawny alias `RouteSource`, żeby uniknąć warunkowego typu w kodzie produkcyjnym. Korelacja stoi przed rolą, bo istniejące dziecko zachowuje wcześniejszą decyzję; jawny marker rodzica nadal ma pierwszeństwo i wykrywa kolizję.

- [ ] **Step 4: GREEN i mutacje**

```bash
bun test ./tests/core/route.test.ts
```

Oczekiwane: 14 pass. Mutacja kontrolna: zamień kolejność `correlated` i `role-default` w implementacji, uruchom ponownie i sprawdź, że przypadek „korelacja bez markera” nadal przechodzi, a przypadek z rolą i korelacją, który wykonawca dopisuje jako 15. wiersz (`child({ role: 'claude-code:explorer', roleDefaultId: FIXTURE_MODEL_ID, correlatedId: OTHER })` oczekujący `correlated`), pada. Przywróć kolejność.

- [ ] **Step 5: Commit**

```bash
git add src/core/route.ts tests/core/route.test.ts
git commit -m "feat: add deterministic route decision"
```

### Task 4: Atomowy zapis pary config i snapshot z wykrywaniem konfliktów

**Files:**
- Create: `src/io/store.ts`
- Test: `tests/io/store.test.ts`

**Interfaces:**
- Consumes: `parseOperatorConfig`, `parseSnapshot`, `sha256`, typy `LoadedState`.
- Produces: `loadState(configPath: string): Promise<LoadedState>`, `commitState(configPath: string, base: LoadedState, change: { config?: OperatorConfig; snapshot?: CatalogSnapshot }): Promise<void>`, `snapshotPathFor(configPath: string): string`.

Zasady: snapshot leży obok configu jako `models.lock.json`; `generation` to `sha256(configHash + ':' + (snapshotHash ?? 'none'))`; `commitState` z jednocześnie `config` i `snapshot` rzuca `store-single-file`; przed zapisem pod blokadą `<config>.lock` (utworzoną flagą `wx`) ponownie liczy hashe obu plików i porównuje z `base.expected`; różnica rzuca `store-conflict`; zapis idzie do pliku tymczasowego w tym samym katalogu i `rename`. Zewnętrzny proces bez blokady jest wykrywany tylko przez porównanie hashy; plan nie obiecuje więcej.

- [ ] **Step 1: Napisz failing testy**

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RouterError } from '../../src/core/errors';
import { commitState, loadState, snapshotPathFor } from '../../src/io/store';
import { configFixture, snapshotFixture } from '../support/fixtures';

let dir = '';
let configPath = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'subagent-router-store-'));
  configPath = join(dir, 'subagent-router.json');
  await writeFile(configPath, JSON.stringify(configFixture()));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('store', () => {
  test('loadState bez snapshotu zwraca snapshotHash null i stabilną generację', async () => {
    const first = await loadState(configPath);
    const second = await loadState(configPath);
    expect(first.snapshot).toBeUndefined();
    expect(first.expected.snapshotHash).toBeNull();
    expect(first.generation).toBe(second.generation);
  });

  test('commitState zapisuje snapshot obok configu i zmienia generację', async () => {
    const base = await loadState(configPath);
    await commitState(configPath, base, { snapshot: await snapshotFixture() });
    const after = await loadState(configPath);
    expect(JSON.parse(await readFile(snapshotPathFor(configPath), 'utf8')).sourceId).toBe('test-gateway');
    expect(after.generation).not.toBe(base.generation);
  });

  test('równoległa edycja configu jest odrzucona bez nadpisania', async () => {
    const base = await loadState(configPath);
    const foreign = configFixture({ defaults: { child: null, unmarkedSubagent: 'error' } });
    foreign.modelOverrides['gateway/fast-worker'] = { description: 'zmiana z zewnątrz' };
    await writeFile(configPath, JSON.stringify(foreign));
    const mine = configFixture();
    mine.modelOverrides['gateway/fast-worker'] = { description: 'moja zmiana' };
    await expect(commitState(configPath, base, { config: mine })).rejects.toMatchObject({ code: 'store-conflict' });
    expect(JSON.parse(await readFile(configPath, 'utf8')).modelOverrides['gateway/fast-worker'].description).toBe('zmiana z zewnątrz');
  });

  test('zmiana obu plików naraz jest odrzucona', async () => {
    const base = await loadState(configPath);
    await expect(commitState(configPath, base, { config: configFixture(), snapshot: await snapshotFixture() })).rejects.toMatchObject({ code: 'store-single-file' });
  });

  test('błędny snapshot na dysku daje RouterError z kodem, nie wyjątek JSON', async () => {
    await writeFile(snapshotPathFor(configPath), '{broken');
    await expect(loadState(configPath)).rejects.toBeInstanceOf(RouterError);
  });

  test('nieudany zapis nie zostawia pliku tymczasowego', async () => {
    const base = await loadState(configPath);
    await writeFile(configPath, JSON.stringify(configFixture({ version: 1 })) + ' ');
    await expect(commitState(configPath, base, { config: configFixture() })).rejects.toMatchObject({ code: 'store-conflict' });
    const entries = (await import('node:fs/promises')).readdir(dir);
    expect((await entries).filter((name) => name.includes('.tmp'))).toEqual([]);
  });
});
```

- [ ] **Step 2: Szkielet i RED**

Szkielet: `loadState` czyta config bez snapshotu i zwraca `generation: ''`, `commitState` nic nie robi.

```bash
bun test ./tests/io/store.test.ts
```

Oczekiwane: porażki na `not.toBe`, `rejects` i odczycie pliku.

- [ ] **Step 3: Zaimplementuj store**

```ts
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseOperatorConfig, parseSnapshot } from '../core/config';
import { RouterError } from '../core/errors';
import { sha256 } from '../core/hash';
import type { CatalogSnapshot, LoadedState, OperatorConfig } from '../core/types';

export function snapshotPathFor(configPath: string): string {
  return join(dirname(configPath), 'models.lock.json');
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function parseJson(text: string, code: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new RouterError(code, 'plik nie jest poprawnym JSON');
  }
}

async function hashes(configPath: string): Promise<{ configText: string; snapshotText: string | null; configHash: string; snapshotHash: string | null }> {
  const configText = await readOptional(configPath);
  if (configText === null) throw new RouterError('config-missing', `brak pliku ${configPath}`);
  const snapshotText = await readOptional(snapshotPathFor(configPath));
  return {
    configText,
    snapshotText,
    configHash: await sha256(configText),
    snapshotHash: snapshotText === null ? null : await sha256(snapshotText),
  };
}

export async function loadState(configPath: string): Promise<LoadedState> {
  const current = await hashes(configPath);
  const config = parseOperatorConfig(parseJson(current.configText, 'config-json'));
  const snapshot = current.snapshotText === null ? undefined : parseSnapshot(parseJson(current.snapshotText, 'snapshot-json'));
  const generation = await sha256(`${current.configHash}:${current.snapshotHash ?? 'none'}`);
  return { config, ...(snapshot ? { snapshot } : {}), expected: { configHash: current.configHash, snapshotHash: current.snapshotHash }, generation };
}

async function withLock<T>(configPath: string, work: () => Promise<T>): Promise<T> {
  const lockPath = `${configPath}.lock`;
  const handle = await open(lockPath, 'wx').catch(() => {
    throw new RouterError('store-locked', 'inny proces trzyma blokadę zapisu');
  });
  try {
    return await work();
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
}

export async function commitState(
  configPath: string,
  base: LoadedState,
  change: { config?: OperatorConfig; snapshot?: CatalogSnapshot },
): Promise<void> {
  if (change.config !== undefined && change.snapshot !== undefined) throw new RouterError('store-single-file', 'zapisz config albo snapshot, nie oba');
  if (change.config === undefined && change.snapshot === undefined) throw new RouterError('store-empty-change', 'brak zmiany do zapisania');
  await withLock(configPath, async () => {
    const current = await hashes(configPath);
    if (current.configHash !== base.expected.configHash || current.snapshotHash !== base.expected.snapshotHash) {
      throw new RouterError('store-conflict', 'pliki zmieniły się od odczytu; odczytaj ponownie');
    }
    const target = change.config !== undefined ? configPath : snapshotPathFor(configPath);
    const payload = JSON.stringify(change.config ?? change.snapshot, null, 2) + '\n';
    const temp = `${target}.${process.pid}.tmp`;
    await mkdir(dirname(target), { recursive: true });
    try {
      await writeFile(temp, payload, { flag: 'wx' });
      await rename(temp, target);
    } finally {
      await rm(temp, { force: true });
    }
  });
}
```

Walidacja nowej wartości przez `parseOperatorConfig` albo `parseSnapshot` przed zapisem jest obowiązkowa; wykonawca dodaje ją na początku `commitState` i test, w którym niepoprawny snapshot nie zostaje zapisany.

- [ ] **Step 4: GREEN**

```bash
bun test ./tests/io/store.test.ts
```

Oczekiwane: 6 pass, brak plików `.tmp` i `.lock` po testach.

- [ ] **Step 5: Commit**

```bash
git add src/io/store.ts tests/io/store.test.ts
git commit -m "feat: add atomic state store with conflict detection"
```

### Task 5: Discovery katalogu i synchronizacja snapshotu

**Files:**
- Create: `src/catalog/discovery.ts`
- Create: `src/catalog/sync.ts`
- Test: `tests/catalog/discovery.test.ts`
- Test: `tests/catalog/sync.test.ts`

**Interfaces:**
- Consumes: `resolveSource`, `validateSource`, `loadState`, `commitState`, `modelAlias`, `sourceFingerprint`, `FetchLike`.
- Produces: `discoverModels(config: OperatorConfig, source: SourceContext, fetcher: FetchLike, signal?: AbortSignal): Promise<readonly { id: string; displayName?: string }[]>`, `synchronize(configPath: string, deps: { env: Env; fetch: FetchLike; now: () => Date; allowEmpty: boolean; dryRun: boolean }): Promise<SyncResult>`.

Kontrakt odpowiedzi: `{"data":[{"id":"...","display_name"?:"..."}],"has_more"?:boolean,"next_cursor"?:string}`. Kolejna strona to ten sam URL z parametrem `cursor`. Odpowiedź bez `has_more` oznacza pełną listę.

- [ ] **Step 1: Napisz failing testy discovery z fake fetch**

```ts
import { describe, expect, test } from 'bun:test';
import { discoverModels } from '../../src/catalog/discovery';
import { RouterError } from '../../src/core/errors';
import type { FetchLike } from '../../src/core/types';
import { resolveSource } from '../../src/io/environment';
import { configFixture } from '../support/fixtures';

const env = { GATEWAY_URL: 'http://127.0.0.1:8000/v1', GATEWAY_HEADERS: '{}', MODELS_AUTH: 'secret-token' };

function fakeFetch(pages: Record<string, unknown>, init: ResponseInit = {}): { fetch: FetchLike; calls: Request[] } {
  const calls: Request[] = [];
  const fetch: FetchLike = async (request) => {
    calls.push(request);
    const cursor = new URL(request.url).searchParams.get('cursor') ?? 'first';
    const body = pages[cursor];
    if (body === undefined) return new Response('not found', { status: 404 });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200, ...init });
  };
  return { fetch, calls };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'no-error';
  } catch (error) {
    return error instanceof RouterError ? error.code : 'other';
  }
}

describe('discoverModels', () => {
  test('pozytywna kontrola: dwie strony z kursorem dają pełną listę w kolejności', async () => {
    const { fetch, calls } = fakeFetch({
      first: { data: [{ id: 'a', display_name: 'A' }], has_more: true, next_cursor: 'p2' },
      p2: { data: [{ id: 'b' }], has_more: false },
    });
    const models = await discoverModels(configFixture(), resolveSource(configFixture(), env), fetch);
    expect(models).toEqual([{ id: 'a', displayName: 'A' }, { id: 'b' }]);
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer secret-token');
    expect(new URL(calls[1]?.url ?? '').searchParams.get('cursor')).toBe('p2');
  });

  test.each([
    ['zły schemat', { first: { models: [] } }, 'discovery-schema'],
    ['puste id', { first: { data: [{ id: '' }] } }, 'discovery-schema'],
    ['duplikat', { first: { data: [{ id: 'a' }, { id: 'a' }] } }, 'discovery-duplicate'],
    ['has_more bez kursora', { first: { data: [{ id: 'a' }], has_more: true } }, 'discovery-pagination'],
    ['cykl kursora', { first: { data: [{ id: 'a' }], has_more: true, next_cursor: 'first' } }, 'discovery-pagination'],
    ['malformed JSON', { first: '{broken' }, 'discovery-json'],
  ])('odrzuca: %s', async (_name, pages, code) => {
    const { fetch } = fakeFetch(pages as Record<string, unknown>);
    expect(await codeOf(discoverModels(configFixture(), resolveSource(configFixture(), env), fetch))).toBe(code);
  });

  test('auth failure daje discovery-auth bez treści nagłówka w komunikacie', async () => {
    const { fetch } = fakeFetch({ first: { data: [] } }, { status: 401 });
    let message = '';
    try {
      await discoverModels(configFixture(), resolveSource(configFixture(), env), fetch);
    } catch (error) {
      message = `${(error as RouterError).code}:${(error as Error).message}`;
    }
    expect(message.startsWith('discovery-auth:')).toBe(true);
    expect(message).not.toContain('secret-token');
  });

  test('przekroczony fetchLimit jest błędem', async () => {
    const config = configFixture({ modelSource: { ...configFixture().modelSource, fetchLimit: 1 } });
    const { fetch } = fakeFetch({ first: { data: [{ id: 'a' }, { id: 'b' }] } });
    expect(await codeOf(discoverModels(config, resolveSource(config, env), fetch))).toBe('discovery-limit');
  });

  test('redirect na inny origin nie jest śledzony z credentials', async () => {
    const calls: Request[] = [];
    const fetch: FetchLike = async (request) => {
      calls.push(request);
      return new Response(null, { status: 302, headers: { location: 'http://evil.example/v1/models' } });
    };
    expect(await codeOf(discoverModels(configFixture(), resolveSource(configFixture(), env), fetch))).toBe('discovery-redirect');
    expect(calls).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Szkielet i RED**

Szkielet zwraca `[]`. Uruchom `bun test ./tests/catalog/discovery.test.ts`. Oczekiwane: porażki asercji `toEqual` i `toBe`.

- [ ] **Step 3: Zaimplementuj discovery**

Wymagania implementacji: `Request` tworzony z `redirect: 'manual'`; status 3xx to `discovery-redirect` niezależnie od celu (plan nie śledzi przekierowań); 401 i 403 to `discovery-auth`; inne statusy poza 2xx to `discovery-http`; timeout przez `AbortSignal.timeout(config.modelSource.timeoutMs)` połączony z opcjonalnym `signal`; liczba modeli po każdej stronie porównana z `fetchLimit`; zbiór odwiedzonych kursorów wykrywa cykl; `display_name` mapowany do `displayName` tylko jeśli jest niepustym ciągiem. Odpowiedź nie steruje URL ani nagłówkami: kursor trafia wyłącznie do parametru `cursor` na `effectiveModelsUrl`.

- [ ] **Step 4: GREEN**

```bash
bun test ./tests/catalog/discovery.test.ts
```

Oczekiwane: 10 pass.

- [ ] **Step 5: Napisz failing testy synchronizacji**

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { synchronize } from '../../src/catalog/sync';
import { sha256 } from '../../src/core/hash';
import type { FetchLike } from '../../src/core/types';
import { snapshotPathFor } from '../../src/io/store';
import { configFixture } from '../support/fixtures';

const env = { GATEWAY_URL: 'http://127.0.0.1:8000/v1', GATEWAY_HEADERS: '{}', MODELS_AUTH: 'secret-token' };
const now = () => new Date('2026-09-06T12:00:00.000Z');

function listing(ids: string[]): FetchLike {
  return async () => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 });
}

let dir = '';
let configPath = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'subagent-router-sync-'));
  configPath = join(dir, 'subagent-router.json');
  await writeFile(configPath, JSON.stringify(configFixture()));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('synchronize', () => {
  test('pierwszy sync zapisuje snapshot z fingerprintem i fetchedAt', async () => {
    const result = await synchronize(configPath, { env, fetch: listing(['gateway/fast-worker']), now, allowEmpty: false, dryRun: false });
    expect(result.added).toEqual(['gateway/fast-worker']);
    const saved = JSON.parse(await readFile(snapshotPathFor(configPath), 'utf8'));
    expect(saved.fetchedAt).toBe('2026-09-06T12:00:00.000Z');
    expect(saved.sourceId).toBe('test-gateway');
    expect(saved.models[0].alias.startsWith('m-')).toBe(true);
  });

  test('zniknięty model zostaje jako missing, powrót przywraca available', async () => {
    await synchronize(configPath, { env, fetch: listing(['a', 'b']), now, allowEmpty: false, dryRun: false });
    const second = await synchronize(configPath, { env, fetch: listing(['a']), now, allowEmpty: false, dryRun: false });
    expect(second.missing).toEqual(['b']);
    expect(second.snapshot.models.find((m) => m.id === 'b')?.status).toBe('missing');
    const third = await synchronize(configPath, { env, fetch: listing(['a', 'b']), now, allowEmpty: false, dryRun: false });
    expect(third.changed).toEqual(['b']);
    expect(third.snapshot.models.find((m) => m.id === 'b')?.status).toBe('available');
  });

  test('dry-run raportuje diff i nie zmienia hashy plików', async () => {
    await synchronize(configPath, { env, fetch: listing(['a']), now, allowEmpty: false, dryRun: false });
    const before = await sha256(await readFile(snapshotPathFor(configPath), 'utf8'));
    const result = await synchronize(configPath, { env, fetch: listing(['a', 'c']), now, allowEmpty: false, dryRun: true });
    expect(result.added).toEqual(['c']);
    expect(await sha256(await readFile(snapshotPathFor(configPath), 'utf8'))).toBe(before);
  });

  test('nieudany fetch zachowuje poprzedni snapshot bajt w bajt', async () => {
    await synchronize(configPath, { env, fetch: listing(['a']), now, allowEmpty: false, dryRun: false });
    const before = await readFile(snapshotPathFor(configPath), 'utf8');
    const failing: FetchLike = async () => new Response('{broken', { status: 200 });
    await expect(synchronize(configPath, { env, fetch: failing, now, allowEmpty: false, dryRun: false })).rejects.toMatchObject({ code: 'discovery-json' });
    expect(await readFile(snapshotPathFor(configPath), 'utf8')).toBe(before);
  });

  test('pusta lista wymaga allowEmpty i nie usuwa wcześniejszych wpisów', async () => {
    await synchronize(configPath, { env, fetch: listing(['a']), now, allowEmpty: false, dryRun: false });
    await expect(synchronize(configPath, { env, fetch: listing([]), now, allowEmpty: false, dryRun: false })).rejects.toMatchObject({ code: 'sync-empty' });
    const result = await synchronize(configPath, { env, fetch: listing([]), now, allowEmpty: true, dryRun: false });
    expect(result.snapshot.models.map((m) => [m.id, m.status])).toEqual([['a', 'missing']]);
  });

  test('sync nie zmienia pliku operatora', async () => {
    const before = await readFile(configPath, 'utf8');
    await synchronize(configPath, { env, fetch: listing(['a']), now, allowEmpty: false, dryRun: false });
    expect(await readFile(configPath, 'utf8')).toBe(before);
  });

  test('zmiana endpointu przy tym samym sourceId odrzuca stary snapshot poza sync', async () => {
    await synchronize(configPath, { env, fetch: listing(['a']), now, allowEmpty: false, dryRun: false });
    const moved = { ...env, GATEWAY_URL: 'http://127.0.0.1:9000/v1' };
    const result = await synchronize(configPath, { env: moved, fetch: listing(['a']), now, allowEmpty: false, dryRun: false });
    expect(result.snapshot.sourceFingerprint).not.toBe((await synchronize(configPath, { env, fetch: listing(['a']), now, allowEmpty: false, dryRun: true })).snapshot.sourceFingerprint);
  });
});
```

- [ ] **Step 6: Szkielet i RED**

Szkielet zwraca `{ snapshot: { version: 1, sourceId: '', sourceFingerprint: '', fetchedAt: '', models: [] }, added: [], changed: [], missing: [] }` bez zapisu. Uruchom `bun test ./tests/catalog/sync.test.ts`, zaobserwuj porażki `toEqual` i brak pliku snapshotu.

- [ ] **Step 7: Zaimplementuj synchronizację**

Kroki implementacji: `loadState`; `resolveSource`; `discoverModels`; jeśli lista pusta i `!allowEmpty` rzuć `sync-empty`; nowy snapshot: dla każdego pobranego ID `status: 'available'` z aliasem `modelAlias(id)` i metadanymi `{ displayName }` gdy podano; dla ID z poprzedniego snapshotu nieobecnego w liście `status: 'missing'` z zachowanymi metadanymi; `added` to ID nieobecne wcześniej, `changed` to ID ze zmienionym statusem lub `displayName`, `missing` to ID, które właśnie przeszły w `missing`; sortuj listy alfabetycznie po kodach jednostek (`localeCompare` z `'en'`, `{ sensitivity: 'variant' }` jest zabronione, użyj porównania `<`), `fetchedAt` z `now().toISOString()`, `sourceFingerprint` liczony ze źródła; przy `dryRun` zwróć wynik bez `commitState`; w przeciwnym razie `commitState(configPath, state, { snapshot })`. Nakładek nie dotykasz, bo są w configu.

- [ ] **Step 8: GREEN i pełny zestaw**

```bash
bun test ./tests/catalog/sync.test.ts && bun run typecheck && bun test
```

Oczekiwane: 7 pass w pliku, 0 fail globalnie.

- [ ] **Step 9: Commit**

```bash
git add src/catalog tests/catalog
git commit -m "feat: add model discovery and snapshot synchronization"
```

### Task 6: Inventory natywnych definicji agentów bez edycji plików

**Files:**
- Create: `src/agents/inventory.ts`
- Create: `src/agents/claude-code.ts`
- Create: `src/agents/opencode.ts`
- Create: `src/agents/codex.ts`
- Create: `tests/fixtures/agents/claude-code/project/.claude/agents/reviewer.md`
- Create: `tests/fixtures/agents/claude-code/home/.claude/agents/reviewer.md`
- Create: `tests/fixtures/agents/claude-code/home/.claude/agents/explorer.md`
- Create: `tests/fixtures/agents/opencode/project/opencode.json`
- Create: `tests/fixtures/agents/opencode/project/.opencode/agents/planner.md`
- Create: `tests/fixtures/agents/codex/home/.codex/agents/reviewer.toml`
- Test: `tests/agents/inventory.test.ts`

**Interfaces:**
- Consumes: typy `AgentDefinition`, `AgentInventory`, `ResolverOptions`, `RouterError`.
- Produces: `readAgentInventory(client: ClientId, options: ResolverOptions): Promise<AgentInventory>`, `getAgent(inventory: AgentInventory, name: string): AgentDefinition`. Parsery YAML i TOML żyją wyłącznie w tej warstwie i używają `Bun.YAML.parse` oraz `Bun.TOML.parse`, zmierzonych lokalnie w Bun 1.3.11. Rdzeń nigdy nie importuje tej warstwy.

Zasady: skan jest `files-only`, chyba że caller przekazał `nativeInventory`; wtedy wynik ma `completeness: 'native'` i role bez pliku otrzymują `availability: 'fileless'`. Kolejność katalogów zapisana w tym zadaniu jest deklaracją do potwierdzenia w M-probe Task 7, nie prawdą o harnessie: dla Claude Code wpis projektowy `.claude/agents` przesłania wpis z katalogu konfiguracji (`CLAUDE_CONFIG_DIR`, potem `configRoot`, potem `~/.claude`); dla OpenCode plik `.opencode/agents/*.md` przesłania blok `agent` w `opencode.json`; dla Codex tylko katalogi `agents` w `~/.codex` i `.codex`. Nazwa efektywna to `name` z frontmatteru albo nazwa pliku bez rozszerzenia. Przesłonięty wpis pozostaje w inventory z `shadowed: true`.

- [ ] **Step 1: Utwórz fixtures**

`tests/fixtures/agents/claude-code/home/.claude/agents/reviewer.md`:

```markdown
---
name: reviewer
description: Przegląd kodu z katalogu domowego.
model: inherit
---
Sprawdzaj regresje.
```

`tests/fixtures/agents/claude-code/project/.claude/agents/reviewer.md` ma `model: sonnet` i treść „Wersja projektowa.” `explorer.md` w katalogu domowym ma `name: file-explorer` i `model: haiku`, co sprawdza nazwę efektywną inną niż nazwa pliku. `opencode.json` zawiera `{"agent":{"planner":{"model":"gateway/base","mode":"subagent","hidden":true}}}`, a `planner.md` w `.opencode/agents` ma frontmatter `model: gateway/from-file`. `reviewer.toml` Codex zawiera `name = "reviewer"` i `model = "gateway/base"`.

- [ ] **Step 2: Napisz failing testy**

```ts
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getAgent, readAgentInventory } from '../../src/agents/inventory';
import { RouterError } from '../../src/core/errors';

const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'agents');

async function treeHash(root: string): Promise<string> {
  const hash = createHash('sha256');
  for (const entry of (await readdir(root, { recursive: true, withFileTypes: true })).filter((e) => e.isFile())) {
    const path = join(entry.parentPath ?? entry.path, entry.name);
    hash.update(path).update(await readFile(path));
  }
  return hash.digest('hex');
}

describe('readAgentInventory claude-code', () => {
  const options = {
    cwd: join(FIXTURES, 'claude-code', 'project'),
    home: join(FIXTURES, 'claude-code', 'home'),
    env: {},
    additionalRoots: [],
  };

  test('wpis projektowy przesłania domowy, a inherit jest zachowane w declaredModel', async () => {
    const inventory = await readAgentInventory('claude-code', options);
    const reviewer = getAgent(inventory, 'reviewer');
    expect(reviewer.declaredModel).toBe('sonnet');
    expect(reviewer.scope).toBe('project');
    const shadowed = inventory.entries.filter((e) => e.name === 'reviewer' && e.shadowed);
    expect(shadowed.map((e) => e.declaredModel)).toEqual(['inherit']);
    expect(inventory.completeness).toBe('files-only');
  });

  test('nazwa efektywna pochodzi z frontmatteru, nie z nazwy pliku', async () => {
    const inventory = await readAgentInventory('claude-code', options);
    expect(getAgent(inventory, 'file-explorer').path?.endsWith('explorer.md')).toBe(true);
    expect(() => getAgent(inventory, 'explorer')).toThrow(RouterError);
  });

  test('CLAUDE_CONFIG_DIR zastępuje katalog domowy', async () => {
    const inventory = await readAgentInventory('claude-code', { ...options, env: { CLAUDE_CONFIG_DIR: join(FIXTURES, 'empty-config') } });
    expect(inventory.entries.some((e) => e.name === 'file-explorer')).toBe(false);
  });

  test('nativeInventory dodaje role fileless bez usuwania plików', async () => {
    const native = { entries: [{ client: 'claude-code' as const, name: 'Explore', scope: 'builtin', hidden: false, native: {}, availability: 'fileless' as const, shadowed: false }], completeness: 'native' as const, diagnostics: [] };
    const inventory = await readAgentInventory('claude-code', { ...options, nativeInventory: native });
    expect(inventory.completeness).toBe('native');
    expect(getAgent(inventory, 'Explore').availability).toBe('fileless');
    expect(getAgent(inventory, 'reviewer').availability).toBe('available');
  });

  test('odczyt nie zmienia żadnego pliku fixture', async () => {
    const before = await treeHash(FIXTURES);
    await readAgentInventory('claude-code', options);
    await readAgentInventory('opencode', { ...options, cwd: join(FIXTURES, 'opencode', 'project'), home: join(FIXTURES, 'opencode', 'home') });
    await readAgentInventory('codex', { ...options, cwd: join(FIXTURES, 'codex', 'project'), home: join(FIXTURES, 'codex', 'home') });
    expect(await treeHash(FIXTURES)).toBe(before);
  });
});

describe('readAgentInventory opencode i codex', () => {
  test('plik Markdown przesłania blok agent z opencode.json i zachowuje hidden', async () => {
    const inventory = await readAgentInventory('opencode', { cwd: join(FIXTURES, 'opencode', 'project'), home: join(FIXTURES, 'opencode', 'home'), env: {}, additionalRoots: [] });
    const planner = getAgent(inventory, 'planner');
    expect(planner.declaredModel).toBe('gateway/from-file');
    expect(inventory.entries.find((e) => e.name === 'planner' && e.shadowed)?.hidden).toBe(true);
  });

  test('rola Codex z TOML ma model i ścieżkę', async () => {
    const inventory = await readAgentInventory('codex', { cwd: join(FIXTURES, 'codex', 'project'), home: join(FIXTURES, 'codex', 'home'), env: {}, additionalRoots: [] });
    expect(getAgent(inventory, 'reviewer').declaredModel).toBe('gateway/base');
  });

  test('additionalRoots jest tylko dodatkowym źródłem odczytu', async () => {
    const inventory = await readAgentInventory('codex', { cwd: join(FIXTURES, 'empty-config'), home: join(FIXTURES, 'empty-config'), env: {}, additionalRoots: [join(FIXTURES, 'codex', 'home', '.codex', 'agents')] });
    expect(getAgent(inventory, 'reviewer').scope).toBe('additional');
  });
});
```

Katalog `tests/fixtures/agents/empty-config` zawiera tylko plik `.keep`.

- [ ] **Step 3: Szkielet i RED**

Szkielet zwraca `{ entries: [], completeness: 'files-only', diagnostics: [] }`, a `getAgent` rzuca `RouterError('agent-unknown')`.

```bash
bun test ./tests/agents/inventory.test.ts
```

Oczekiwane: wszystkie testy poza „odczyt nie zmienia żadnego pliku” padają na asercjach.

- [ ] **Step 4: Zaimplementuj parsery i scalanie**

`src/agents/claude-code.ts` eksportuje `readClaudeAgents(options): Promise<AgentDefinition[]>`: wylicza roots w kolejności `[cwd/.claude/agents (scope 'project'), env.CLAUDE_CONFIG_DIR/agents lub configRoot/agents lub home/.claude/agents (scope 'user'), ...additionalRoots (scope 'additional')]`, czyta pliki `*.md`, dzieli frontmatter `---` i parsuje go przez `Bun.YAML.parse`, tworzy `AgentDefinition` z `native` równym sparsowanemu frontmatterowi i `body` równym treści. `src/agents/opencode.ts` czyta `opencode.json` z `cwd` i `home/.config/opencode`, pole `agent`, oraz pliki `.opencode/agents/*.md` i `home/.config/opencode/agents/*.md`. `src/agents/codex.ts` czyta `*.toml` z `cwd/.codex/agents` i `home/.codex/agents` przez `Bun.TOML.parse`. `src/agents/inventory.ts` scala: pierwsza definicja danej nazwy w kolejności roots jest efektywna, kolejne dostają `shadowed: true`; jeśli `nativeInventory` istnieje, jego wpisy bez odpowiednika pliku są dołączane jako `fileless`, a `completeness` wynosi `'native'`. `getAgent` zwraca efektywny wpis albo rzuca `agent-unknown` z nazwą.

- [ ] **Step 5: GREEN**

```bash
bun test ./tests/agents/inventory.test.ts
```

Oczekiwane: 8 pass, hash fixtures niezmieniony.

- [ ] **Step 6: Commit**

```bash
git add src/agents/inventory.ts src/agents/claude-code.ts src/agents/opencode.ts src/agents/codex.ts tests/agents tests/fixtures/agents
git commit -m "feat: read native agent definitions read-only"
```

### Task 7: Capture gateway, próby harnessów i profile możliwości

**Files:**
- Create: `tests/support/capture-gateway.ts`
- Create: `tests/probes/run.ts`
- Create: `tests/probes/evidence.test.ts`
- Create: `src/adapters/capabilities.ts`
- Create: `tests/fixtures/capabilities/claude-code-2.1.263.json`
- Create: `tests/fixtures/capabilities/opencode-1.18.29.json`
- Create: `tests/fixtures/capabilities/codex-pending.json`
- Test: `tests/adapters/capabilities.test.ts`

**Interfaces:**
- Consumes: typ `CapabilityProfile`, `RouterError`.
- Produces: `startCaptureGateway(): Promise<{ url: string; requests: CapturedRequest[]; close: () => Promise<void> }>` z `CapturedRequest { method: string; path: string; headers: Record<string, string>; model?: string; agentId?: string; isChild?: boolean; body: unknown }`; `assertCapability(profile: CapabilityProfile, feature: 'native' | 'marker' | 'correlation' | 'fork'): void`; `loadCapabilityProfile(client: ClientId, version: string, fixturesDir: string): Promise<CapabilityProfile>`.

Profil startowy każdego klienta ma `status: 'pending'` i wszystkie próby `pending`. Zmiana na `supported` następuje wyłącznie przez zapis wyniku próby z `tests/probes/run.ts`, uruchomionej ręcznie przeciw prawdziwemu harnessowi w izolowanym katalogu konfiguracji, z bramą capture jako celem. Wynik zapisany w fixture zawiera wersję binarium, datę i identyfikatory bez treści promptów.

- [ ] **Step 1: Napisz failing test bramy capture**

```ts
import { describe, expect, test } from 'bun:test';
import { startCaptureGateway } from '../support/capture-gateway';

describe('capture gateway', () => {
  test('rejestruje model, nagłówek agenta i marker dziecka z body', async () => {
    const gateway = await startCaptureGateway();
    try {
      const response = await fetch(`${gateway.url}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-claude-code-agent-id': 'agent-1' },
        body: JSON.stringify({
          model: 'gateway/fast-worker',
          system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_is_subagent=true' }],
          messages: [{ role: 'user', content: 'hej' }],
        }),
      });
      expect(response.status).toBe(200);
      expect(gateway.requests).toHaveLength(1);
      expect(gateway.requests[0]).toMatchObject({ path: '/v1/messages', model: 'gateway/fast-worker', agentId: 'agent-1', isChild: true });
    } finally {
      await gateway.close();
    }
  });

  test('odpowiada poprawnym strumieniem SSE, który klient może zdekodować', async () => {
    const gateway = await startCaptureGateway();
    try {
      const response = await fetch(`${gateway.url}/v1/messages`, { method: 'POST', body: JSON.stringify({ model: 'm', stream: true, messages: [] }) });
      const text = await response.text();
      expect(response.headers.get('content-type')).toBe('text/event-stream');
      expect(text).toContain('event: message_stop');
    } finally {
      await gateway.close();
    }
  });
});
```

- [ ] **Step 2: Szkielet i RED**

Szkielet startuje `Bun.serve` na porcie 0 i zwraca 404 dla wszystkiego. Uruchom `bun test ./tests/probes/evidence.test.ts`; oczekiwane porażki `toBe(200)` i `toHaveLength(1)`.

- [ ] **Step 3: Zaimplementuj bramę**

Brama parsuje JSON, wyciąga `model`, nagłówek `x-claude-code-agent-id`, wykrywa `cc_is_subagent=true` w pierwszym bloku `system`, zapisuje request do tablicy i zwraca minimalną poprawną odpowiedź Anthropic (`message` z jednym blokiem tekstu) albo SSE z `message_start`, `content_block_delta`, `message_stop`. Brama jest narzędziem testowym: działa tylko na `127.0.0.1`, nie loguje treści na dysk.

- [ ] **Step 4: GREEN**

```bash
bun test ./tests/probes/evidence.test.ts
```

Oczekiwane: 2 pass.

- [ ] **Step 5: Napisz failing test profili**

```ts
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { assertCapability, loadCapabilityProfile } from '../../src/adapters/capabilities';
import { RouterError } from '../../src/core/errors';

const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'capabilities');

describe('capabilities', () => {
  test('profil pending odmawia każdej funkcji kodem unsupported-path', async () => {
    const profile = await loadCapabilityProfile('codex', 'pending', FIXTURES);
    for (const feature of ['native', 'marker', 'correlation', 'fork'] as const) {
      expect(() => assertCapability(profile, feature)).toThrow(RouterError);
    }
  });

  test('profil supported bez zaliczonego M1 nadal odmawia korelacji', async () => {
    const profile = await loadCapabilityProfile('claude-code', '2.1.263', FIXTURES);
    expect(profile.status).toBe('pending');
    expect(profile.probes.M1).toBe('pending');
    expect(() => assertCapability(profile, 'correlation')).toThrow(RouterError);
  });

  test('nieznana wersja nie jest mapowana na najbliższy profil', async () => {
    await expect(loadCapabilityProfile('claude-code', '2.1.999', FIXTURES)).rejects.toBeInstanceOf(RouterError);
  });
});
```

Fixture `claude-code-2.1.263.json`:

```json
{
  "client": "claude-code",
  "version": "2.1.263",
  "status": "pending",
  "correlation": false,
  "fork": false,
  "probes": { "M1": "pending", "M2": "pending", "M3": "pending", "M4": "pending", "M10": "pending" }
}
```

- [ ] **Step 6: Szkielet, RED, implementacja, GREEN**

Szkielet `assertCapability` nic nie robi, `loadCapabilityProfile` zwraca stały obiekt `supported`. Uruchom `bun test ./tests/adapters/capabilities.test.ts` i zaobserwuj porażki `toThrow`. Implementacja: plik `<client>-<version>.json` czytany dosłownie, brak pliku to `RouterError('capability-unknown-version')`; `assertCapability` wymaga `status === 'supported'` oraz dla `correlation` pola `correlation: true`, dla `fork` pola `fork: true`, dla `marker` zaliczonego `M3` lub `M10`, dla `native` zaliczonego `M10`; każdy brak rzuca `RouterError('unsupported-path')`.

```bash
bun test ./tests/adapters/capabilities.test.ts
```

Oczekiwane: 3 pass.

- [ ] **Step 7: Napisz runner prób jako narzędzie ręczne**

`tests/probes/run.ts` przyjmuje argumenty `--client`, `--probe`, `--config-root <tmp>` i `--binary <path>`. Uruchamia bramę capture, przygotowuje izolowany katalog konfiguracji z syntetycznymi agentami, uruchamia harness w trybie nieinteraktywnym z endpointem bramy i zapisuje do stdout JSON `{ probe, client, version, result: 'passed' | 'failed', evidence: { requestCount, distinctAgentIds, childRequests } }`. Skrypt nie zapisuje fixtures automatycznie; operator kopiuje wynik do `tests/fixtures/capabilities` świadomie. Skrypt nie może dotykać prawdziwego `HOME` operatora: ustawia `HOME`, `CLAUDE_CONFIG_DIR`, `XDG_CONFIG_HOME` i `CODEX_HOME` na katalog tymczasowy. Uruchomienie prawdziwego harnessu jest krokiem opt-in poza `bun test`.

Test jednostkowy skryptu w `tests/probes/evidence.test.ts` sprawdza wyłącznie funkcję czystą `summarizeEvidence(requests: CapturedRequest[]): Evidence`: dwa requesty z tym samym `agentId` dają `distinctAgentIds: 1`, request bez `isChild` nie liczy się do `childRequests`.

- [ ] **Step 8: Commit**

```bash
git add tests/support/capture-gateway.ts tests/probes src/adapters/capabilities.ts tests/fixtures/capabilities tests/adapters/capabilities.test.ts
git commit -m "feat: add capture gateway, probe runner and capability profiles"
```

### Task 8: Markery Claude Code, katalog w opisie narzędzi i korelacja

**Files:**
- Create: `src/adapters/markers.ts`
- Create: `src/adapters/correlation.ts`
- Create: `src/adapters/claude-code.ts`
- Test: `tests/adapters/markers.test.ts`
- Test: `tests/adapters/correlation.test.ts`
- Test: `tests/adapters/claude-code.test.ts`

**Interfaces:**
- Consumes: `EffectiveCatalog`, `resolveModel`, `RouteInput`, `CapabilityProfile`, `sha256`.
- Produces: `parseMarker(text: string): ParsedMarker | 'invalid' | null` z `ParsedMarker = { kind: 'parent'; alias: string } | { kind: 'adapter'; role: string; agent: string; token: string }`; `signRoleMarker(secret: string, role: string, agent: string): Promise<string>`; `extractMarkers(body: Record<string, unknown>, agentId: string | undefined, secret: string | undefined): Promise<{ explicitAliases: string[]; roleFromAdapter?: string; markerError?: 'invalid-marker' | 'conflicting-markers'; ignored: number; stripped: Record<string, unknown> }>`; `class CorrelationStore { constructor(now: () => number, ttlMs: number); get(agentId: string): string | undefined; bind(agentId: string, modelId: string): void }`; `enrichParentTools(body: Record<string, unknown>, catalog: EffectiveCatalog): Record<string, unknown>`; `normalizeClaudeRequest(body: Record<string, unknown>, headers: Headers, options: { secret?: string; profile: CapabilityProfile; correlation?: CorrelationStore; catalog: EffectiveCatalog; roles: OperatorConfig['roles'] }): Promise<{ input: RouteInput; forwardBody: Record<string, unknown>; agentId?: string }>`.

Gramatyka markera jest dokładnie tą ze spec D2. Token to `sha256` HMAC: `HMAC-SHA-256(secret, 'v=1|role=<role>|agent=<agent>')` liczony przez `crypto.subtle` z kluczem `HMAC`. Pozycje autoryzowane: dowolny blok `system` (tylko wariant adaptera z poprawnym tokenem i zgodnym `agent`), pierwsza linia pierwszego bloku tekstowego pierwszej wiadomości `user` bez `tool_result` (tylko wariant rodzica). Wszystkie inne wystąpienia liczą się do `ignored`.

- [ ] **Step 1: Napisz failing testy parsera**

```ts
import { describe, expect, test } from 'bun:test';
import { extractMarkers, parseMarker, signRoleMarker } from '../../src/adapters/markers';

const SECRET = 'test-secret';

describe('parseMarker', () => {
  test.each([
    ['<subagent-router v="1" model="fast"/>', { kind: 'parent', alias: 'fast' }],
    ['<subagent-router v="1" role="reviewer" agent="agent-1" token="abc"/>', { kind: 'adapter', role: 'reviewer', agent: 'agent-1', token: 'abc' }],
    ['<subagent-router v="2" model="fast"/>', 'invalid'],
    ['<subagent-router v="1" model="fast" role="x"/>', 'invalid'],
    ['<subagent-router v="1" model="9bad"/>', 'invalid'],
    ['<subagent-router v="1" model="fast">', 'invalid'],
    ['zwykły tekst', null],
  ])('%s', (text, expected) => {
    expect(parseMarker(text)).toEqual(expected as never);
  });
});

function body(system: unknown[], messages: unknown[]): Record<string, unknown> {
  return { model: 'client-alias', system, messages };
}

describe('extractMarkers', () => {
  test('marker rodzica w pierwszej linii promptu delegacji jest jawnym wyborem i zostaje usunięty z kopii', async () => {
    const input = body([], [{ role: 'user', content: [{ type: 'text', text: '<subagent-router v="1" model="fast"/>\nZbadaj repo.' }] }]);
    const result = await extractMarkers(input, 'agent-1', SECRET);
    expect(result.explicitAliases).toEqual(['fast']);
    expect((result.stripped.messages as Array<{ content: Array<{ text: string }> }>)[0]?.content[0]?.text).toBe('Zbadaj repo.');
    expect((input.messages as Array<{ content: Array<{ text: string }> }>)[0]?.content[0]?.text.startsWith('<subagent-router')).toBe(true);
  });

  test('marker w drugiej linii, w tool_result i w drugiej wiadomości jest ignorowany', async () => {
    const input = body([], [
      { role: 'user', content: [{ type: 'text', text: 'Zbadaj repo.\n<subagent-router v="1" model="fast"/>' }] },
      { role: 'assistant', content: [{ type: 'text', text: '<subagent-router v="1" model="fast"/>' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: '<subagent-router v="1" model="fast"/>' }] },
    ]);
    const result = await extractMarkers(input, 'agent-1', SECRET);
    expect(result.explicitAliases).toEqual([]);
    expect(result.ignored).toBe(3);
  });

  test('marker adaptera w system jest przyjęty tylko z poprawnym tokenem i zgodnym agentem', async () => {
    const token = await signRoleMarker(SECRET, 'reviewer', 'agent-1');
    const ok = body([{ type: 'text', text: `<subagent-router v="1" role="reviewer" agent="agent-1" token="${token}"/>` }], []);
    expect((await extractMarkers(ok, 'agent-1', SECRET)).roleFromAdapter).toBe('reviewer');
    const wrongAgent = await extractMarkers(ok, 'agent-2', SECRET);
    expect(wrongAgent.roleFromAdapter).toBeUndefined();
    expect(wrongAgent.ignored).toBe(1);
    const forged = body([{ type: 'text', text: '<subagent-router v="1" role="reviewer" agent="agent-1" token="0000"/>' }], []);
    expect((await extractMarkers(forged, 'agent-1', SECRET)).ignored).toBe(1);
  });

  test('marker rodzica w system oraz marker z CLAUDE.md są ignorowane', async () => {
    const input = body([{ type: 'text', text: 'Instrukcje projektu\n<subagent-router v="1" model="fast"/>' }], []);
    const result = await extractMarkers(input, 'agent-1', SECRET);
    expect(result.explicitAliases).toEqual([]);
    expect(result.ignored).toBe(1);
  });

  test('niepoprawny marker w autoryzowanej pozycji to invalid-marker, dwa różne to conflicting-markers', async () => {
    const invalid = body([], [{ role: 'user', content: [{ type: 'text', text: '<subagent-router v="9" model="fast"/>' }] }]);
    expect((await extractMarkers(invalid, 'agent-1', SECRET)).markerError).toBe('invalid-marker');
    const conflicting = body([], [{ role: 'user', content: [{ type: 'text', text: '<subagent-router v="1" model="fast"/>' }, { type: 'text', text: '<subagent-router v="1" model="slow"/>' }] }]);
    const result = await extractMarkers(conflicting, 'agent-1', SECRET);
    expect(result.explicitAliases).toEqual(['fast']);
    expect(result.ignored).toBe(1);
  });
});
```

Ostatni przypadek pokazuje, że tylko pierwsza linia pierwszego bloku jest autoryzowana; drugi blok liczy się jako zignorowany. `conflicting-markers` powstaje w Task 3, gdy adapter przekaże dwa różne `explicitIds`, co jest możliwe tylko przez kanał korelacji lub przyszłe rozszerzenie pozycji; test w Task 3 to pokrywa.

- [ ] **Step 2: Szkielet i RED**

Szkielet: `parseMarker` zwraca `null`, `extractMarkers` zwraca puste wartości i `stripped` równe wejściu. Uruchom `bun test ./tests/adapters/markers.test.ts`; oczekiwane porażki `toEqual`.

- [ ] **Step 3: Zaimplementuj parser, HMAC i ekstrakcję**

Parser oparty o jedno wyrażenie regularne dla całej linii: `^<subagent-router((?:\s+[a-z]+="[^"]*")+)\s*\/>$`, atrybuty rozbite osobno i sprawdzone względem dokładnie dwóch dozwolonych zestawów. `stripped` to `structuredClone(body)` z usuniętym markerem z autoryzowanej pozycji; oryginał pozostaje nietknięty. Marker w `system` przyjmuje się tylko po zweryfikowaniu tokenu porównaniem stałoczasowym (`crypto.subtle.verify` z kluczem HMAC).

- [ ] **Step 4: GREEN**

```bash
bun test ./tests/adapters/markers.test.ts
```

Oczekiwane: 12 pass.

- [ ] **Step 5: Napisz failing test korelacji i zaimplementuj**

```ts
import { describe, expect, test } from 'bun:test';
import { CorrelationStore } from '../../src/adapters/correlation';

describe('CorrelationStore', () => {
  test('wpis wygasa po ttl liczonym od ostatniego użycia', () => {
    let clock = 0;
    const store = new CorrelationStore(() => clock, 1000);
    store.bind('agent-1', 'gateway/a');
    clock = 900;
    expect(store.get('agent-1')).toBe('gateway/a');
    clock = 1800;
    expect(store.get('agent-1')).toBe('gateway/a');
    clock = 2900;
    expect(store.get('agent-1')).toBeUndefined();
  });

  test('różne identyfikatory nie dzielą decyzji', () => {
    const store = new CorrelationStore(() => 0, 1000);
    store.bind('agent-1', 'gateway/a');
    expect(store.get('agent-2')).toBeUndefined();
  });
});
```

Szkielet zwraca `undefined`; RED na `toBe('gateway/a')`. Implementacja: `Map<string, { modelId: string; lastUsed: number }>`, `get` odświeża `lastUsed` i usuwa wygasłe wpisy, `bind` nadpisuje ten sam identyfikator tylko tym samym modelem, inny model rzuca `RouterError('correlation-conflict')`.

```bash
bun test ./tests/adapters/correlation.test.ts
```

Oczekiwane: 2 pass.

- [ ] **Step 6: Napisz failing test adaptera Claude**

```ts
import { describe, expect, test } from 'bun:test';
import { enrichParentTools, normalizeClaudeRequest } from '../../src/adapters/claude-code';
import { CorrelationStore } from '../../src/adapters/correlation';
import { buildCatalog } from '../../src/core/catalog';
import type { CapabilityProfile } from '../../src/core/types';
import { FIXTURE_MODEL_ID, configFixture, snapshotFixture } from '../support/fixtures';

const profile: CapabilityProfile = { client: 'claude-code', version: '2.1.263', status: 'pending', correlation: false, fork: false, probes: {} };

describe('enrichParentTools', () => {
  test('dodaje katalog tylko do narzędzi Agent, Task i Workflow, idempotentnie i bez modeli bez opisu', async () => {
    const catalog = buildCatalog(configFixture(), await snapshotFixture([FIXTURE_MODEL_ID, 'gateway/undescribed']));
    const body = { tools: [{ name: 'Agent', description: 'Launch agent', input_schema: { properties: { prompt: { description: 'Prompt' } } } }, { name: 'Bash', description: 'Run' }] };
    const once = enrichParentTools(body, catalog);
    const twice = enrichParentTools(once, catalog);
    const agent = (twice.tools as Array<{ name: string; description: string; input_schema: { properties: { prompt: { description: string } } } }>)[0];
    expect(agent?.description.startsWith('Launch agent')).toBe(true);
    expect(agent?.description).toContain('fast');
    expect(agent?.description).not.toContain('gateway/undescribed');
    expect(agent?.description.split('<subagent-router').length).toBe(2);
    expect(agent?.input_schema.properties.prompt.description).toContain('pierwsz');
    expect((twice.tools as Array<{ name: string; description: string }>)[1]?.description).toBe('Run');
    expect((body.tools[0] as { description: string }).description).toBe('Launch agent');
  });
});

describe('normalizeClaudeRequest', () => {
  test('request bez billing metadata jest rodzicem nawet z nagłówkiem agenta', async () => {
    const catalog = buildCatalog(configFixture(), await snapshotFixture());
    const result = await normalizeClaudeRequest({ model: 'claude', messages: [] }, new Headers({ 'x-claude-code-agent-id': 'agent-1' }), { profile, catalog, roles: configFixture().roles });
    expect(result.input.scope).toBe('parent');
  });

  test('dziecko z markerem rodzica dostaje explicitIds po dokładnym ID i clientModel z requestu', async () => {
    const catalog = buildCatalog(configFixture(), await snapshotFixture());
    const body = {
      model: 'claude-haiku',
      system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_is_subagent=true' }],
      messages: [{ role: 'user', content: '<subagent-router v="1" model="fast"/>\nZadanie' }],
    };
    const result = await normalizeClaudeRequest(body, new Headers({ 'x-claude-code-agent-id': 'agent-1' }), { profile, catalog, roles: configFixture().roles });
    expect(result.input).toMatchObject({ scope: 'child', explicitIds: [FIXTURE_MODEL_ID], clientModel: 'claude-haiku', ignoredMarkers: 0 });
    expect(result.agentId).toBe('agent-1');
    expect((result.forwardBody.messages as Array<{ content: string }>)[0]?.content).toBe('Zadanie');
  });

  test('nieznany alias w markerze rodzica trafia do core jako explicitId, nie jako brak markera', async () => {
    const catalog = buildCatalog(configFixture(), await snapshotFixture());
    const body = { model: 'x', system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_is_subagent=true' }], messages: [{ role: 'user', content: '<subagent-router v="1" model="ghost"/>' }] };
    const result = await normalizeClaudeRequest(body, new Headers(), { profile, catalog, roles: configFixture().roles });
    expect(result.input.explicitIds).toEqual(['ghost']);
  });

  test('korelacja jest używana tylko przy profilu z correlation true', async () => {
    const catalog = buildCatalog(configFixture(), await snapshotFixture());
    const store = new CorrelationStore(() => 0, 1000);
    store.bind('agent-1', FIXTURE_MODEL_ID);
    const body = { model: 'x', system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_is_subagent=true' }], messages: [{ role: 'user', content: 'bez markera' }] };
    const off = await normalizeClaudeRequest(body, new Headers({ 'x-claude-code-agent-id': 'agent-1' }), { profile, catalog, roles: configFixture().roles, correlation: store });
    expect(off.input.correlatedId).toBeUndefined();
    const on = await normalizeClaudeRequest(body, new Headers({ 'x-claude-code-agent-id': 'agent-1' }), { profile: { ...profile, status: 'supported', correlation: true }, catalog, roles: configFixture().roles, correlation: store });
    expect(on.input.correlatedId).toBe(FIXTURE_MODEL_ID);
  });
});
```

- [ ] **Step 7: Szkielet, RED, implementacja, GREEN**

Szkielety: `enrichParentTools` zwraca wejście, `normalizeClaudeRequest` zwraca `scope: 'parent'`. Uruchom `bun test ./tests/adapters/claude-code.test.ts`, zaobserwuj porażki. Implementacja `enrichParentTools`: klon body; dla narzędzi o nazwach `Agent`, `Task`, `Workflow` (porównanie bez wielkości liter) dopisz do `description` blok zaczynający się od `\n\n<subagent-router catalog>` z listą `alias: opis` wyłącznie dla modeli `enabled` z opisem oraz instrukcją umieszczenia markera w pierwszej linii promptu; opis pola `prompt` dostaje zdanie o pierwszej linii; jeśli blok już istnieje, nie dopisuj. `normalizeClaudeRequest`: rozpoznaj dziecko przez `cc_is_subagent=true` w pierwszym bloku `system` (obsłuż JSON i format `k=v;`), usuń ten blok z `forwardBody`; wywołaj `extractMarkers`; alias rodzica mapuj na ID przez `catalog.byAlias`, nieznany alias przekaż dosłownie w `explicitIds`; `roleFromAdapter` mapuj przez `roles[`claude-code:${role}`]?.routeOverride` do `roleDefaultId`; korelację czytaj tylko gdy `profile.correlation && agentId`; `clientModel` to `body.model`.

```bash
bun test ./tests/adapters/claude-code.test.ts
```

Oczekiwane: 5 pass.

- [ ] **Step 8: Commit**

```bash
git add src/adapters/markers.ts src/adapters/correlation.ts src/adapters/claude-code.ts tests/adapters
git commit -m "feat: add Claude Code marker parsing, tool catalog and correlation"
```

### Task 9: Handler HTTP i wyjście hooków Claude

**Files:**
- Create: `src/transport/handler.ts`
- Create: `src/transport/hooks.ts`
- Test: `tests/transport/handler.test.ts`
- Test: `tests/transport/hooks.test.ts`

**Interfaces:**
- Consumes: `normalizeClaudeRequest`, `enrichParentTools`, `resolveRoute`, `CorrelationStore`, `buildCatalog`, `SourceContext`, `signRoleMarker`.
- Produces: `createHandler(options: { config: OperatorConfig; snapshot: CatalogSnapshot; source: SourceContext; profile: CapabilityProfile; secret?: string; fetch: FetchLike; now: () => number }): (request: Request) => Promise<Response>`; `createClaudeStartOutput(input: { agent_id: string; agent_type: string }, options: { secret: string; roles: OperatorConfig['roles'] }): Promise<Record<string, unknown>>`.

Zakres handlera: `POST /v1/messages` i `POST /v1/messages/count_tokens` przechodzą przez normalizację i decyzję; pozostałe ścieżki są przekazywane bez odczytu body. Endpoint kontrolny `POST /subagent-router/register` przyjmuje `{ agent, role, token }` i zapisuje rolę dla `agent` w pamięci procesu po weryfikacji tokenu; nigdy nie jest przekazywany upstream. Nagłówki bramy z `source.headers` są dodawane do requestu upstream, nagłówek `host` jest usuwany.

- [ ] **Step 1: Napisz failing testy handlera z fake fetch**

```ts
import { describe, expect, test } from 'bun:test';
import { signRoleMarker } from '../../src/adapters/markers';
import type { CapabilityProfile, FetchLike } from '../../src/core/types';
import { createHandler } from '../../src/transport/handler';
import { FIXTURE_MODEL_ID, configFixture, snapshotFixture } from '../support/fixtures';

const source = { sourceId: 'test-gateway', effectiveGatewayUrl: 'http://127.0.0.1:8000/v1', effectiveModelsUrl: 'http://127.0.0.1:8000/v1/models', headers: { 'X-Team': 'router' } };
const profile: CapabilityProfile = { client: 'claude-code', version: '2.1.263', status: 'supported', correlation: false, fork: false, probes: { M3: 'passed', M10: 'passed' } };
const CHILD_SYSTEM = [{ type: 'text', text: 'x-anthropic-billing-header: cc_is_subagent=true' }];

function upstream(): { fetch: FetchLike; seen: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> } {
  const seen: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
  const fetch: FetchLike = async (request) => {
    seen.push({ url: request.url, body: (await request.json()) as Record<string, unknown>, headers: request.headers });
    return new Response(JSON.stringify({ id: 'msg', content: [{ type: 'text', text: 'ok' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, seen };
}

async function handlerWith(fetch: FetchLike) {
  return createHandler({ config: configFixture(), snapshot: await snapshotFixture(), source, profile, secret: 'test-secret', fetch, now: () => 0 });
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://router.local${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

describe('createHandler', () => {
  test('dziecko z markerem dostaje upstreamModel, marker znika, rodzic jest przekazywany bez zmian modelu', async () => {
    const { fetch, seen } = upstream();
    const handler = await handlerWith(fetch);
    const child = await handler(post('/v1/messages', { model: 'claude-haiku', system: CHILD_SYSTEM, messages: [{ role: 'user', content: '<subagent-router v="1" model="fast"/>\nZadanie' }] }));
    expect(child.status).toBe(200);
    expect(seen[0]?.body.model).toBe(FIXTURE_MODEL_ID);
    expect(JSON.stringify(seen[0]?.body)).not.toContain('subagent-router');
    expect(seen[0]?.headers.get('x-team')).toBe('router');
    expect(seen[0]?.url).toBe('http://127.0.0.1:8000/v1/messages');
    await handler(post('/v1/messages', { model: 'claude-opus', messages: [{ role: 'user', content: 'rodzic' }] }));
    expect(seen[1]?.body.model).toBe('claude-opus');
  });

  test('dziecko bez wskazania dostaje 422 z kodem missing-selection i brama nie jest wołana', async () => {
    const { fetch, seen } = upstream();
    const handler = await handlerWith(fetch);
    const response = await handler(post('/v1/messages', { model: 'x', system: CHILD_SYSTEM, messages: [{ role: 'user', content: 'bez markera' }] }));
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('missing-selection');
    expect(seen).toHaveLength(0);
  });

  test('rodzic z cytowanym markerem w tool_result przechodzi bez zmian', async () => {
    const { fetch, seen } = upstream();
    const handler = await handlerWith(fetch);
    await handler(post('/v1/messages', { model: 'claude-opus', messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: '<subagent-router v="1" model="fast"/>' }] }] }));
    expect(seen[0]?.body.model).toBe('claude-opus');
  });

  test('rejestracja roli przez endpoint kontrolny działa tylko z poprawnym tokenem i nie idzie upstream', async () => {
    const { fetch, seen } = upstream();
    const handler = await handlerWith(fetch);
    const bad = await handler(post('/subagent-router/register', { agent: 'agent-1', role: 'explorer', token: '0000' }));
    expect(bad.status).toBe(401);
    const token = await signRoleMarker('test-secret', 'explorer', 'agent-1');
    const good = await handler(post('/subagent-router/register', { agent: 'agent-1', role: 'explorer', token }));
    expect(good.status).toBe(204);
    await handler(post('/v1/messages', { model: 'x', system: CHILD_SYSTEM, messages: [{ role: 'user', content: 'bez markera' }] }, { 'x-claude-code-agent-id': 'agent-1' }));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.body.model).toBe(FIXTURE_MODEL_ID);
  });

  test('strumień i anulowanie są przekazywane bez buforowania', async () => {
    let aborted = false;
    const fetch: FetchLike = async (request) => {
      request.signal.addEventListener('abort', () => { aborted = true; });
      const stream = new ReadableStream<Uint8Array>({ pull() { return new Promise(() => {}); } });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    const handler = await handlerWith(fetch);
    const controller = new AbortController();
    const request = new Request('http://router.local/v1/messages', { method: 'POST', body: JSON.stringify({ model: 'claude-opus', stream: true, messages: [] }), signal: controller.signal });
    const response = await handler(request);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(aborted).toBe(true);
  });

  test('inne ścieżki są przekazywane bez odczytu body', async () => {
    const { fetch, seen } = upstream();
    const handler = await handlerWith(fetch);
    await handler(post('/v1/models', {}));
    expect(seen[0]?.url).toBe('http://127.0.0.1:8000/v1/models');
  });
});
```

- [ ] **Step 2: Szkielet i RED**

Szkielet zwraca `new Response(null, { status: 501 })`. Uruchom `bun test ./tests/transport/handler.test.ts`; oczekiwane porażki na statusach i `seen`.

- [ ] **Step 3: Zaimplementuj handler**

Struktura: `catalog = buildCatalog(config, snapshot)` raz na instancję; `roles` z configu; `registry = new Map<string, string>()` dla rejestracji hooka; `correlation = profile.correlation ? new CorrelationStore(now, 3600000) : undefined`. Dla ścieżek routowalnych: odczytaj JSON (błąd JSON to 400), `normalizeClaudeRequest`, jeśli `input.roleDefaultId` jest puste i `registry` zna `agentId`, ustaw `roleDefaultId` z `roles[`claude-code:${registry.get(agentId)}`]`; przy `scope === 'parent'` dodatkowo `enrichParentTools`; `resolveRoute`; `error` daje 422 z `{ error: { code, ignoredMarkers } }`; `route` podmienia `forwardBody.model`, binduje korelację gdy aktywna; `pass-through` używa oryginalnego body. Request upstream: URL to `source.effectiveGatewayUrl` plus ścieżka bez prefiksu `/v1` (obie strony kończą i zaczynają `/v1`, więc użyj `new URL(path.replace(/^\/v1/, ''), effectiveGatewayUrl + '/')`), nagłówki klienta bez `host` i `content-length`, plus `source.headers`; `signal: request.signal`; odpowiedź zwracana z tym samym `status`, `headers` i `body` bez odczytu strumienia. Endpoint kontrolny: weryfikacja `signRoleMarker(secret, role, agent) === token` porównaniem stałoczasowym, odpowiedź 204 albo 401.

- [ ] **Step 4: GREEN**

```bash
bun test ./tests/transport/handler.test.ts
```

Oczekiwane: 6 pass.

- [ ] **Step 5: Napisz failing test hooka i zaimplementuj**

```ts
import { describe, expect, test } from 'bun:test';
import { parseMarker } from '../../src/adapters/markers';
import { createClaudeStartOutput } from '../../src/transport/hooks';
import { configFixture } from '../support/fixtures';

describe('createClaudeStartOutput', () => {
  test('zwraca additionalContext z markerem adaptera dla roli znanej w konfiguracji', async () => {
    const output = await createClaudeStartOutput({ agent_id: 'agent-1', agent_type: 'explorer' }, { secret: 'test-secret', roles: configFixture().roles });
    const context = (output.hookSpecificOutput as { hookEventName: string; additionalContext: string });
    expect(context.hookEventName).toBe('SubagentStart');
    const marker = parseMarker(context.additionalContext.split('\n')[0] ?? '');
    expect(marker).toMatchObject({ kind: 'adapter', role: 'explorer', agent: 'agent-1' });
    expect(context.additionalContext).not.toContain('test-secret');
  });

  test('rola bez trasy nie wstrzykuje markera', async () => {
    const output = await createClaudeStartOutput({ agent_id: 'agent-1', agent_type: 'unknown-role' }, { secret: 'test-secret', roles: configFixture().roles });
    expect(output).toEqual({});
  });
});
```

Szkielet zwraca `{}`; RED na `toBe('SubagentStart')`. Implementacja buduje marker przez `signRoleMarker` i zwraca strukturę zgodną z dokumentacją hooków Claude Code. Miejsce, w którym `additionalContext` ląduje w requeście, rozstrzyga pomiar M3; do tego czasu handler akceptuje wariant adaptera w `system` i w pierwszej linii pierwszej wiadomości `user`.

```bash
bun test ./tests/transport/hooks.test.ts
```

Oczekiwane: 2 pass.

- [ ] **Step 6: Commit**

```bash
git add src/transport tests/transport
git commit -m "feat: add routing handler and Claude hook output"
```

### Task 10: OpenCode: warianty agentów i walidacja wyboru w czasie wykonania

**Files:**
- Create: `src/adapters/opencode.ts`
- Test: `tests/adapters/opencode.test.ts`

**Interfaces:**
- Consumes: `AgentInventory`, `getAgent`, `EffectiveCatalog`, `resolveRoute`, `CapabilityProfile`, `assertCapability`.
- Produces: `opencodeVariants(inventory: AgentInventory, config: OperatorConfig, catalog: EffectiveCatalog): ExportFile[]`; `validateOpenCodeTask(args: unknown, inventory: AgentInventory, config: OperatorConfig, catalog: EffectiveCatalog, profile: CapabilityProfile): RouteDecision`.

Nazwa wariantu to `ROLE@ALIAS`. Wariant kopiuje `native` definicji bazowej i nadpisuje wyłącznie `name`, `description`, `hidden: true` i `model: <providerId>/<upstreamModel>`. Eksport generuje jeden plik Markdown na wariant dla ról z plikami oraz jeden fragment `opencode.agents.json` dla ról zdefiniowanych w `opencode.json`. Modele bez opisu nie dostają wariantu. `validateOpenCodeTask` przyjmuje argumenty natywnego `task` (`subagent_type`, `description`, `prompt`) i zwraca decyzję core dla wybranego wariantu; sam nie zmienia argumentów. Guard runtime jest pluginem `tool.execute.before`, którego rejestrację potwierdza pomiar M6; do tego czasu `profile.status !== 'supported'` daje `unsupported-path`.

- [ ] **Step 1: Napisz failing testy**

```ts
import { describe, expect, test } from 'bun:test';
import { opencodeVariants, validateOpenCodeTask } from '../../src/adapters/opencode';
import { buildCatalog } from '../../src/core/catalog';
import type { AgentInventory, CapabilityProfile } from '../../src/core/types';
import { FIXTURE_MODEL_ID, configFixture, snapshotFixture } from '../support/fixtures';

const inventory: AgentInventory = {
  entries: [{
    client: 'opencode', name: 'reviewer', scope: 'project', path: '/x/.opencode/agents/reviewer.md', declaredModel: 'inherit', hidden: false,
    body: 'Sprawdzaj regresje.', native: { description: 'Przegląd', tools: { bash: false }, permission: { edit: 'deny' }, mode: 'subagent' }, availability: 'available', shadowed: false,
  }],
  completeness: 'files-only',
  diagnostics: [],
};
const supported: CapabilityProfile = { client: 'opencode', version: '1.18.29', status: 'supported', correlation: false, fork: false, probes: { M6: 'passed', M10: 'passed' } };
const pending: CapabilityProfile = { ...supported, status: 'pending', probes: {} };

describe('opencodeVariants', () => {
  test('wariant zachowuje narzędzia, uprawnienia i treść, zmienia tylko nazwę, opis, hidden i model', async () => {
    const files = opencodeVariants(inventory, configFixture(), buildCatalog(configFixture(), await snapshotFixture([FIXTURE_MODEL_ID, 'gateway/undescribed'])));
    expect(files.map((f) => f.relativePath)).toEqual(['opencode/agents/reviewer@fast.md']);
    const content = files[0]?.content ?? '';
    expect(content).toContain('name: reviewer@fast');
    expect(content).toContain(`model: gateway/${FIXTURE_MODEL_ID}`);
    expect(content).toContain('hidden: true');
    expect(content).toContain('bash: false');
    expect(content).toContain("edit: deny");
    expect(content.trimEnd().endsWith('Sprawdzaj regresje.')).toBe(true);
    expect(content).not.toContain('undescribed');
  });
});

describe('validateOpenCodeTask', () => {
  test('wariant znany w katalogu daje route z dokładnym upstreamModel', async () => {
    const catalog = buildCatalog(configFixture(), await snapshotFixture());
    const decision = validateOpenCodeTask({ subagent_type: 'reviewer@fast', prompt: 'x', description: 'y' }, inventory, configFixture(), catalog, supported);
    expect(decision).toEqual({ kind: 'route', upstreamModel: FIXTURE_MODEL_ID, clientModel: 'haiku', source: 'explicit', ignoredMarkers: 0 });
  });

  test('wariant z aliasem spoza katalogu i nieznana rola dają błąd, bez zmiany args', async () => {
    const catalog = buildCatalog(configFixture(), await snapshotFixture());
    const args = { subagent_type: 'reviewer@ghost', prompt: 'x', description: 'y' };
    expect(validateOpenCodeTask(args, inventory, configFixture(), catalog, supported)).toMatchObject({ kind: 'error', code: 'unknown-model' });
    expect(validateOpenCodeTask({ subagent_type: 'nobody@fast', prompt: 'x', description: 'y' }, inventory, configFixture(), catalog, supported)).toMatchObject({ kind: 'error', code: 'unsupported-path' });
    expect(args.subagent_type).toBe('reviewer@ghost');
  });

  test('bazowa rola bez wariantu przechodzi jako pass-through dziedziczenia natywnego tylko przy jawnym inherit', async () => {
    const catalog = buildCatalog(configFixture(), await snapshotFixture());
    expect(validateOpenCodeTask({ subagent_type: 'reviewer' }, inventory, configFixture(), catalog, supported)).toMatchObject({ kind: 'error', code: 'missing-selection' });
    const config = configFixture({ defaults: { child: null, unmarkedSubagent: 'inherit', unmarkedSubagentAcknowledged: true } });
    expect(validateOpenCodeTask({ subagent_type: 'reviewer' }, inventory, config, catalog, supported)).toMatchObject({ kind: 'pass-through', reason: 'inherit-allowed' });
  });

  test('profil pending odmawia z unsupported-path', async () => {
    const catalog = buildCatalog(configFixture(), await snapshotFixture());
    expect(validateOpenCodeTask({ subagent_type: 'reviewer@fast' }, inventory, configFixture(), catalog, pending)).toMatchObject({ kind: 'error', code: 'unsupported-path' });
  });
});
```

- [ ] **Step 2: Szkielet i RED**

Szkielet: `opencodeVariants` zwraca `[]`, `validateOpenCodeTask` zwraca `unsupported-path`. Uruchom `bun test ./tests/adapters/opencode.test.ts`; oczekiwane porażki `toEqual` i `toMatchObject`.

- [ ] **Step 3: Zaimplementuj**

`opencodeVariants`: dla każdej roli `available` z `path` i każdego modelu `enabled` z opisem zbuduj frontmatter przez `Bun.YAML.stringify({ ...native, name, description, hidden: true, model })` i doklej `body`. `validateOpenCodeTask`: `assertCapability(profile, 'native')` z mapowaniem wyjątku na `unsupported-path`; rozbij `subagent_type` na `role` i opcjonalny `alias` po ostatnim `@`; rola musi istnieć w inventory (`unsupported-path` gdy brak); alias mapowany na `explicitIds` przez `catalog.byAlias` albo przekazany dosłownie; `roleDefaultId` z `config.roles[`opencode:${role}`]`; wywołaj `resolveRoute` z `scope: 'child'`.

- [ ] **Step 4: GREEN**

```bash
bun test ./tests/adapters/opencode.test.ts
```

Oczekiwane: 5 pass.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/opencode.ts tests/adapters/opencode.test.ts
git commit -m "feat: add OpenCode variants and task validation"
```

### Task 11: Codex: obowiązkowy hook walidujący model i precedencję ról

**Files:**
- Create: `src/adapters/codex.ts`
- Test: `tests/adapters/codex.test.ts`

**Interfaces:**
- Consumes: `AgentInventory`, `EffectiveCatalog`, `resolveRoute`, `CapabilityProfile`, `assertCapability`.
- Produces: `validateCodexSpawn(args: unknown, inventory: AgentInventory, config: OperatorConfig, catalog: EffectiveCatalog, profile: CapabilityProfile): RouteDecision`; `codexHookOutput(decision: RouteDecision): Record<string, unknown>`.

Hook `PreToolUse` z matcherem `Agent` dostaje `tool_input` narzędzia `spawn_agent` (`model?`, `role?` lub `agent?`, `prompt`). Decyzja `error` daje `permissionDecision: "deny"` z powodem zawierającym kod. Decyzja `route` i `pass-through` zwraca pusty obiekt: hook nie wystawia `allow`, żeby nie omijać innych polityk, i nie używa `updatedInput`. Model podany jawnie jest przekazywany do core jako `explicitIds` po dokładnym ID; alias nie jest w Codex akceptowany, bo natywne pole musi być identyfikatorem bramy.

- [ ] **Step 1: Napisz failing testy**

```ts
import { describe, expect, test } from 'bun:test';
import { codexHookOutput, validateCodexSpawn } from '../../src/adapters/codex';
import { buildCatalog } from '../../src/core/catalog';
import type { AgentInventory, CapabilityProfile } from '../../src/core/types';
import { FIXTURE_MODEL_ID, configFixture, snapshotFixture } from '../support/fixtures';

const inventory: AgentInventory = {
  entries: [{ client: 'codex', name: 'reviewer', scope: 'user', path: '/h/.codex/agents/reviewer.toml', declaredModel: 'gateway/base', hidden: false, native: {}, availability: 'available', shadowed: false }],
  completeness: 'files-only',
  diagnostics: [],
};
const supported: CapabilityProfile = { client: 'codex', version: '0.153.4', status: 'supported', correlation: false, fork: false, probes: { M5: 'passed', M7: 'passed', M9: 'passed', M10: 'passed' } };

describe('validateCodexSpawn', () => {
  test('jawny model z katalogu daje route, model spoza katalogu daje unknown-model', async () => {
    const catalog = buildCatalog(configFixture(), await snapshotFixture());
    expect(validateCodexSpawn({ model: FIXTURE_MODEL_ID, prompt: 'x' }, inventory, configFixture(), catalog, supported)).toMatchObject({ kind: 'route', upstreamModel: FIXTURE_MODEL_ID, source: 'explicit' });
    expect(validateCodexSpawn({ model: 'gateway/ghost', prompt: 'x' }, inventory, configFixture(), catalog, supported)).toMatchObject({ kind: 'error', code: 'unknown-model' });
    expect(validateCodexSpawn({ model: 'fast', prompt: 'x' }, inventory, configFixture(), catalog, supported)).toMatchObject({ kind: 'error', code: 'unknown-model' });
  });

  test('rola bez modelu używa routeOverride, a jawny model wygrywa z rolą', async () => {
    const config = configFixture({ roles: { 'codex:reviewer': { routeOverride: FIXTURE_MODEL_ID } } });
    const catalog = buildCatalog(config, await snapshotFixture([FIXTURE_MODEL_ID, 'gateway/other']));
    expect(validateCodexSpawn({ role: 'reviewer', prompt: 'x' }, inventory, config, catalog, supported)).toMatchObject({ kind: 'route', upstreamModel: FIXTURE_MODEL_ID, source: 'role-default' });
    expect(validateCodexSpawn({ role: 'reviewer', model: 'gateway/other', prompt: 'x' }, inventory, config, catalog, supported)).toMatchObject({ kind: 'route', upstreamModel: 'gateway/other', source: 'explicit' });
  });

  test('spawn bez modelu i bez roli z trasą to missing-selection', async () => {
    const catalog = buildCatalog(configFixture(), await snapshotFixture());
    expect(validateCodexSpawn({ prompt: 'x' }, inventory, configFixture(), catalog, supported)).toMatchObject({ kind: 'error', code: 'missing-selection' });
  });

  test('profil bez zaliczonego M7 odmawia całego adaptera', async () => {
    const catalog = buildCatalog(configFixture(), await snapshotFixture());
    const profile: CapabilityProfile = { ...supported, status: 'pending', probes: { M7: 'failed' } };
    expect(validateCodexSpawn({ model: FIXTURE_MODEL_ID, prompt: 'x' }, inventory, configFixture(), catalog, profile)).toMatchObject({ kind: 'error', code: 'unsupported-path' });
  });
});

describe('codexHookOutput', () => {
  test('błąd daje deny z kodem, sukces nie wystawia allow ani updatedInput', () => {
    const denied = codexHookOutput({ kind: 'error', code: 'model-not-allowed', ignoredMarkers: 0 });
    expect(denied).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'subagent-router: model-not-allowed' } });
    expect(codexHookOutput({ kind: 'route', upstreamModel: 'x', source: 'explicit', ignoredMarkers: 0 })).toEqual({});
  });
});
```

- [ ] **Step 2: Szkielet i RED**

Szkielet zwraca `unsupported-path` oraz `{}`. Uruchom `bun test ./tests/adapters/codex.test.ts`; oczekiwane porażki `toMatchObject` i `toEqual`.

- [ ] **Step 3: Zaimplementuj**

`validateCodexSpawn`: `assertCapability(profile, 'native')` z mapowaniem na `unsupported-path`; odczytaj `role` z `args.role` albo `args.agent`; jeśli podano `role`, musi istnieć w inventory, inaczej `unsupported-path`; `explicitIds` to `[args.model]` gdy jest ciągiem (bez mapowania aliasu); `roleDefaultId` z `config.roles[`codex:${role}`]`; `resolveRoute` z `scope: 'child'`. `codexHookOutput` zwraca `deny` tylko dla `error`.

- [ ] **Step 4: GREEN i pełny zestaw**

```bash
bun test ./tests/adapters/codex.test.ts && bun run typecheck && bun test
```

Oczekiwane: 6 pass w pliku, 0 fail globalnie.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/codex.ts tests/adapters/codex.test.ts
git commit -m "feat: add Codex spawn validation hook logic"
```

### Task 12: CLI tylko do odczytu, podgląd trasy i diagnostyka offline

**Files:**
- Create: `src/cli/args.ts`
- Create: `src/cli/output.ts`
- Create: `src/cli/read.ts`
- Create: `src/cli/main.ts`
- Test: `tests/cli/read.test.ts`

**Interfaces:**
- Consumes: `loadState`, `buildCatalog`, `resolveModel`, `resolveRoute`, `readAgentInventory`, `getAgent`, `loadCapabilityProfile`, `resolveSource`, `validateSource`, typ `CliDeps`.
- Produces: `parseArgs(argv: readonly string[]): ParsedArgs` z `ParsedArgs = { command: string[]; options: Record<string, string | boolean>; positionals: string[] }`; `render(deps: CliDeps, payload: unknown, human: () => string): void`; `previewRoute(options: { client: ClientId; agent: string; model?: string; parentModel?: string }, state: LoadedState, inventory: AgentInventory, profile: CapabilityProfile): { mode: 'simulation'; generation: string; decision: RouteDecision; agent: { name: string; declaredModel: string | 'unknown'; scope: string } }`; `runCli(argv: readonly string[], deps: CliDeps): Promise<0 | 1 | 2>`.

Komendy tego zadania: `models list`, `models show <id-or-alias>`, `agents list --client <c>`, `agents show <name> --client <c>`, `route preview --client <c> --agent <name> [--model <ref>] [--parent-model <m>]`, `config show`, `config check`, `doctor` (offline). Parser argumentów używa `parseArgs` z `node:util` dostępnego w Bun i Node. Globalne opcje: `--config`, `--json`, `--no-color`, `--agents-dir` (wielokrotna), `--help`, `--version`. Domyślny config to `<cwd>/subagent-router.json`. Wyjście JSON idzie w całości na stdout; diagnostyka na stderr. Kody wyjścia: 0 sukces, 1 błąd operacyjny (`RouterError` z I/O lub sieci), 2 błąd użycia, konfiguracji albo wyboru. Każdy ciąg z katalogu, opisu lub nazwy agenta przechodzi przez `escapeControl` (znaki sterujące i sekwencje ANSI zamieniane na `\uXXXX`) przed wypisaniem w trybie tekstowym.

- [ ] **Step 1: Napisz failing testy odczytu z fałszywymi zależnościami**

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../../src/cli/main';
import type { CliDeps } from '../../src/core/types';
import { FIXTURE_MODEL_ID, configFixture, snapshotFixture } from '../support/fixtures';

let dir = '';
let out: string[] = [];
let err: string[] = [];

function deps(patch: Partial<CliDeps> = {}): CliDeps {
  return {
    cwd: dir,
    home: join(dir, 'home'),
    env: { GATEWAY_URL: 'http://127.0.0.1:8000/v1', GATEWAY_HEADERS: '{}', MODELS_AUTH: 'secret-token', ROUTER_SECRET: 'hook-secret' },
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    isTTY: false,
    fetch: async () => { throw new Error('sieć zabroniona w testach odczytu'); },
    now: () => new Date('2026-09-06T12:00:00.000Z'),
    ...patch,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'subagent-router-cli-'));
  out = [];
  err = [];
  await mkdir(join(dir, 'home', '.claude', 'agents'), { recursive: true });
  await writeFile(join(dir, 'home', '.claude', 'agents', 'explorer.md'), '---\nname: explorer\nmodel: inherit\n---\nSzukaj.\n');
  await writeFile(join(dir, 'subagent-router.json'), JSON.stringify(configFixture()));
  await writeFile(join(dir, 'models.lock.json'), JSON.stringify(await snapshotFixture([FIXTURE_MODEL_ID, 'gateway/undescribed'])));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function lastJson(): Record<string, unknown> {
  return JSON.parse(out.join('')) as Record<string, unknown>;
}

describe('read-only CLI', () => {
  test('models list --json pokazuje status, alias i brak opisu bez sięgania do sieci', async () => {
    expect(await runCli(['models', 'list', '--json'], deps())).toBe(0);
    const rows = lastJson().models as Array<Record<string, unknown>>;
    expect(rows.map((r) => [r.id, r.alias, r.status, r.description ?? null])).toEqual([
      [FIXTURE_MODEL_ID, 'fast', 'available', 'Szybkie zadania.'],
      ['gateway/undescribed', rows[1]?.alias, 'available', null],
    ]);
    expect(lastJson().fetchedAt).toBe('2026-09-06T00:00:00.000Z');
  });

  test('models show akceptuje alias, zwraca dokładne ID i nie normalizuje wielkości liter', async () => {
    expect(await runCli(['models', 'show', 'fast', '--json'], deps())).toBe(0);
    expect(lastJson().id).toBe(FIXTURE_MODEL_ID);
    out = [];
    expect(await runCli(['models', 'show', 'Fast', '--json'], deps())).toBe(2);
    expect(err.join('')).toContain('unknown-model');
  });

  test('agents show pokazuje declaredModel inherit, scope i router override', async () => {
    expect(await runCli(['agents', 'show', 'explorer', '--client', 'claude-code', '--json'], deps())).toBe(0);
    expect(lastJson()).toMatchObject({ name: 'explorer', declaredModel: 'inherit', scope: 'user', routeOverride: FIXTURE_MODEL_ID });
  });

  test('route preview symuluje decyzję z generacją plików, bez uruchamiania agenta i sieci', async () => {
    expect(await runCli(['route', 'preview', '--client', 'claude-code', '--agent', 'explorer', '--json'], deps())).toBe(0);
    const preview = lastJson();
    expect(preview.mode).toBe('simulation');
    expect(typeof preview.generation).toBe('string');
    expect(preview.decision).toMatchObject({ kind: 'route', upstreamModel: FIXTURE_MODEL_ID, source: 'role-default' });
    out = [];
    expect(await runCli(['route', 'preview', '--client', 'claude-code', '--agent', 'explorer', '--model', 'gateway/undescribed', '--json'], deps())).toBe(0);
    expect(lastJson().decision).toMatchObject({ kind: 'route', upstreamModel: 'gateway/undescribed', source: 'explicit' });
  });

  test('config show ukrywa wartości nagłówków i sekretów, także w JSON', async () => {
    expect(await runCli(['config', 'show', '--json'], deps())).toBe(0);
    const text = out.join('');
    expect(text).not.toContain('secret-token');
    expect(text).not.toContain('hook-secret');
    expect(text).toContain('MODELS_AUTH');
  });

  test('config check zgłasza trasę do nieistniejącej roli i kończy kodem 2', async () => {
    const broken = configFixture({ roles: { 'claude-code:nobody': { routeOverride: FIXTURE_MODEL_ID } } });
    await writeFile(join(dir, 'subagent-router.json'), JSON.stringify(broken));
    expect(await runCli(['config', 'check', '--json'], deps())).toBe(2);
    expect(JSON.stringify(lastJson().problems)).toContain('claude-code:nobody');
  });

  test('brak snapshotu nie blokuje agents list, ale blokuje preview z instrukcją sync', async () => {
    await rm(join(dir, 'models.lock.json'));
    expect(await runCli(['agents', 'list', '--client', 'claude-code', '--json'], deps())).toBe(0);
    out = [];
    expect(await runCli(['route', 'preview', '--client', 'claude-code', '--agent', 'explorer', '--json'], deps())).toBe(2);
    expect(err.join('')).toContain('models sync');
  });

  test('tryb tekstowy bez TTY nie zawiera ANSI, a znaki sterujące z opisu są escapowane', async () => {
    const config = configFixture();
    config.modelOverrides[FIXTURE_MODEL_ID] = { alias: 'fast', description: 'zły[31m opis' };
    await writeFile(join(dir, 'subagent-router.json'), JSON.stringify(config));
    expect(await runCli(['models', 'list'], deps())).toBe(0);
    expect(out.join('')).not.toContain('');
    expect(out.join('')).toContain('\\u001b');
  });

  test('doctor offline raportuje stan configured, measured i pending bez sieci', async () => {
    expect(await runCli(['doctor', '--json'], deps())).toBe(0);
    const report = lastJson();
    expect(report.network).toBe(false);
    expect((report.clients as Array<Record<string, unknown>>).map((c) => c.status)).toEqual(['pending', 'pending', 'pending']);
  });

  test('nieznana komenda i błędne użycie dają kod 2 z pomocą na stderr', async () => {
    expect(await runCli(['models', 'explode'], deps())).toBe(2);
    expect(err.join('')).toContain('models');
  });
});
```

Wersje bazowe profili dla `doctor` pochodzą z `tests/fixtures/capabilities` w testach i z katalogu `capabilities` w paczce w runtime; brak profilu dla wykrytej wersji jest raportowany jako `unknown`, nie jako `supported`.

- [ ] **Step 2: Szkielet i RED**

Szkielet `runCli` zwraca `1` i nic nie pisze. Uruchom `bun test ./tests/cli/read.test.ts`; oczekiwane porażki na kodzie wyjścia i pustym stdout.

- [ ] **Step 3: Zaimplementuj parser, wyjście i komendy**

`args.ts`: `parseArgs` z `node:util` z opcjami `config`, `json`, `no-color`, `agents-dir` (multiple), `client`, `agent`, `model`, `parent-model`, `help`, `version`, `allowUnknown: false`; pierwsze dwa positionals to komenda. `output.ts`: `escapeControl`, `render` wybierający JSON albo tekst, brak ANSI gdy `!deps.isTTY` lub `--no-color`. `read.ts`: jedna funkcja na komendę, każda zwraca `{ code, payload, human }`; `previewRoute` buduje `RouteInput` z `scope: 'child'`, `role` z `client:agent`, `explicitIds` z `--model` (alias mapowany przez katalog), `roleDefaultId` z ról, `clientModel` z `--parent-model` gdy podano, i wywołuje `resolveRoute`; wynik zawsze ma `mode: 'simulation'` i `generation` ze `LoadedState`. `main.ts`: mapowanie błędów: `RouterError` z kodem zaczynającym się od `config-`, `snapshot-`, `unknown-model`, `agent-unknown`, `usage-` daje 2; pozostałe `RouterError` dają 1; nieznany wyjątek daje 1 z komunikatem bez stosu.

- [ ] **Step 4: GREEN**

```bash
bun test ./tests/cli/read.test.ts
```

Oczekiwane: 10 pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli/args.ts src/cli/output.ts src/cli/read.ts src/cli/main.ts tests/cli/read.test.ts
git commit -m "feat: add read-only CLI with route preview and doctor"
```

### Task 13: Komendy zapisujące: sync, describe, export, doctor --connect i serve

**Files:**
- Create: `src/cli/write.ts`
- Create: `src/cli/serve.ts`
- Create: `src/agents/export.ts`
- Modify: `src/cli/main.ts` (tylko dispatch nowych komend)
- Test: `tests/cli/write.test.ts`
- Test: `tests/cli/export.test.ts`
- Test: `tests/cli/serve.test.ts`

**Interfaces:**
- Consumes: `synchronize`, `loadState`, `commitState`, `opencodeVariants`, `readAgentInventory`, `createHandler`, `createClaudeStartOutput`, `discoverModels`, `resolveSource`.
- Produces: `describeModel(configPath: string, reference: string, description: string | null): Promise<void>`; `exportConfig(configPath: string, client: ClientId, outputDir: string, options: { dryRun: boolean; force: boolean; inventory: AgentInventory; catalogRequired: boolean }): Promise<ExportFile[]>`; `startServer(configPath: string, deps: CliDeps, options: { port: number; host: string }): Promise<{ url: string; generation: string; stop: () => Promise<void> }>`; `dumpToml(value: Record<string, unknown>): string` w `src/agents/export.ts`.

Serializacja TOML: `Bun.TOML.stringify` nie istnieje w Bun 1.3.11 (zmierzone). Eksport Codex używa własnego `dumpToml` obsługującego wyłącznie ciągi, liczby, wartości logiczne, tablice ciągów i jedną warstwę tabel; każda inna wartość rzuca `RouterError('export-unsupported-value')`. Test roundtrip parsuje wynik przez `Bun.TOML.parse` i porównuje z wejściem. Nie dodawaj zależności runtime dla TOML.

- [ ] **Step 1: Napisz failing testy komend zapisujących**

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../../src/cli/main';
import { sha256 } from '../../src/core/hash';
import type { CliDeps, FetchLike } from '../../src/core/types';
import { FIXTURE_MODEL_ID, configFixture, snapshotFixture } from '../support/fixtures';

let dir = '';
let out: string[] = [];
let err: string[] = [];

function listing(ids: string[]): FetchLike {
  return async () => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 });
}

function deps(fetch: FetchLike): CliDeps {
  return {
    cwd: dir, home: join(dir, 'home'),
    env: { GATEWAY_URL: 'http://127.0.0.1:8000/v1', GATEWAY_HEADERS: '{}', MODELS_AUTH: 'secret-token', ROUTER_SECRET: 'hook-secret' },
    stdout: (t) => out.push(t), stderr: (t) => err.push(t), isTTY: false, fetch, now: () => new Date('2026-09-06T12:00:00.000Z'),
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'subagent-router-write-'));
  out = [];
  err = [];
  await writeFile(join(dir, 'subagent-router.json'), JSON.stringify(configFixture()));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('models sync', () => {
  test('dry-run pokazuje diff i nie tworzy snapshotu', async () => {
    expect(await runCli(['models', 'sync', '--dry-run', '--json'], deps(listing(['a'])))).toBe(0);
    expect(JSON.parse(out.join('')).added).toEqual(['a']);
    await expect(readFile(join(dir, 'models.lock.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('pusta lista bez allow-empty kończy się kodem 1 i bez pliku', async () => {
    expect(await runCli(['models', 'sync'], deps(listing([])))).toBe(1);
    expect(err.join('')).toContain('sync-empty');
    await expect(readFile(join(dir, 'models.lock.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('błąd auth nie wypisuje tokenu i zachowuje poprzedni snapshot', async () => {
    await writeFile(join(dir, 'models.lock.json'), JSON.stringify(await snapshotFixture()));
    const before = await sha256(await readFile(join(dir, 'models.lock.json'), 'utf8'));
    const unauthorized: FetchLike = async () => new Response('nope', { status: 401 });
    expect(await runCli(['models', 'sync'], deps(unauthorized))).toBe(1);
    expect(err.join('')).not.toContain('secret-token');
    expect(await sha256(await readFile(join(dir, 'models.lock.json'), 'utf8'))).toBe(before);
  });
});

describe('models describe', () => {
  test('zapisuje opis w modelOverrides po dokładnym ID, nie w snapshotcie', async () => {
    await writeFile(join(dir, 'models.lock.json'), JSON.stringify(await snapshotFixture([FIXTURE_MODEL_ID, 'gateway/other'])));
    const snapshotBefore = await readFile(join(dir, 'models.lock.json'), 'utf8');
    expect(await runCli(['models', 'describe', 'gateway/other', '--text', 'Wolny, dokładny.'], deps(listing([])))).toBe(0);
    const config = JSON.parse(await readFile(join(dir, 'subagent-router.json'), 'utf8'));
    expect(config.modelOverrides['gateway/other']).toEqual({ description: 'Wolny, dokładny.' });
    expect(await readFile(join(dir, 'models.lock.json'), 'utf8')).toBe(snapshotBefore);
  });

  test('tryby --text, --file i --clear są rozłączne, a --clear usuwa tylko opis', async () => {
    await writeFile(join(dir, 'models.lock.json'), JSON.stringify(await snapshotFixture()));
    expect(await runCli(['models', 'describe', 'fast', '--text', 'a', '--clear'], deps(listing([])))).toBe(2);
    expect(await runCli(['models', 'describe', 'fast', '--clear'], deps(listing([])))).toBe(0);
    const config = JSON.parse(await readFile(join(dir, 'subagent-router.json'), 'utf8'));
    expect(config.modelOverrides[FIXTURE_MODEL_ID]).toEqual({ alias: 'fast', enabled: true, clientModel: 'haiku' });
  });

  test('opis modelu missing jest zapisywany, ale model pozostaje nieaktywny', async () => {
    const snapshot = await snapshotFixture([FIXTURE_MODEL_ID]);
    (snapshot.models[0] as { status: string }).status = 'missing';
    await writeFile(join(dir, 'models.lock.json'), JSON.stringify(snapshot));
    expect(await runCli(['models', 'describe', FIXTURE_MODEL_ID, '--text', 'nowy'], deps(listing([])))).toBe(0);
    out = [];
    expect(await runCli(['models', 'show', FIXTURE_MODEL_ID, '--json'], deps(listing([])))).toBe(0);
    expect(JSON.parse(out.join(''))).toMatchObject({ description: 'nowy', status: 'missing', enabled: false });
  });

  test('równoległa zmiana configu między odczytem a zapisem jest odrzucona', async () => {
    await writeFile(join(dir, 'models.lock.json'), JSON.stringify(await snapshotFixture()));
    const racingFetch: FetchLike = async () => new Response('{}', { status: 200 });
    const racing = deps(racingFetch);
    const original = racing.now;
    racing.now = () => {
      void writeFile(join(dir, 'subagent-router.json'), JSON.stringify(configFixture({ defaults: { child: null, unmarkedSubagent: 'error' } })) + '\n');
      return original();
    };
    const code = await runCli(['models', 'describe', 'fast', '--text', 'x'], racing);
    expect([0, 1]).toContain(code);
    if (code === 1) expect(err.join('')).toContain('store-conflict');
  });
});
```

Ostatni test jest niedeterministyczny w wersji z `now`; wykonawca zastępuje go deterministycznym testem jednostkowym `commitState` z `base` o nieaktualnym hashu, jak w Task 4, i sprawdza w CLI wyłącznie mapowanie `store-conflict` na kod 1 z komunikatem. Nie zostawiaj testu opartego o wyścig.

- [ ] **Step 2: Napisz failing testy eksportu**

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dumpToml } from '../../src/agents/export';
import { runCli } from '../../src/cli/main';
import type { CliDeps } from '../../src/core/types';
import { FIXTURE_MODEL_ID, configFixture, snapshotFixture } from '../support/fixtures';

let dir = '';
let out: string[] = [];
let err: string[] = [];

function deps(): CliDeps {
  return { cwd: join(dir, 'project'), home: join(dir, 'home'), env: { GATEWAY_URL: 'http://127.0.0.1:8000/v1', GATEWAY_HEADERS: '{}', MODELS_AUTH: 't', ROUTER_SECRET: 's' }, stdout: (t) => out.push(t), stderr: (t) => err.push(t), isTTY: false, fetch: async () => { throw new Error('sieć zabroniona'); }, now: () => new Date() };
}

async function treeHash(root: string): Promise<string> {
  const hash = createHash('sha256');
  for (const entry of (await readdir(root, { recursive: true, withFileTypes: true })).filter((e) => e.isFile())) {
    const path = join(entry.parentPath ?? entry.path, entry.name);
    hash.update(path).update(await readFile(path));
  }
  return hash.digest('hex');
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'subagent-router-export-'));
  out = [];
  err = [];
  await mkdir(join(dir, 'project', '.opencode', 'agents'), { recursive: true });
  await mkdir(join(dir, 'home', '.codex', 'agents'), { recursive: true });
  await writeFile(join(dir, 'project', '.opencode', 'agents', 'reviewer.md'), '---\ndescription: Przegląd\nmodel: inherit\n---\nSprawdzaj.\n');
  await writeFile(join(dir, 'home', '.codex', 'agents', 'reviewer.toml'), 'name = "reviewer"\nmodel = "gateway/base"\n');
  await writeFile(join(dir, 'project', 'subagent-router.json'), JSON.stringify(configFixture({ roles: { 'codex:reviewer': { routeOverride: FIXTURE_MODEL_ID } } })));
  await writeFile(join(dir, 'project', 'models.lock.json'), JSON.stringify(await snapshotFixture()));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('config export', () => {
  test('eksport OpenCode zapisuje wariant do katalogu artefaktów i nie zmienia natywnych plików', async () => {
    const before = await treeHash(join(dir, 'project', '.opencode'));
    expect(await runCli(['config', 'export', '--client', 'opencode', '--output', join(dir, 'out'), '--json'], deps())).toBe(0);
    expect(await readFile(join(dir, 'out', 'opencode', 'agents', 'reviewer@fast.md'), 'utf8')).toContain('model: gateway/gateway/fast-worker');
    expect(await treeHash(join(dir, 'project', '.opencode'))).toBe(before);
  });

  test('eksport Codex generuje rolę TOML z routeOverride, którą Bun.TOML.parse czyta z powrotem', async () => {
    expect(await runCli(['config', 'export', '--client', 'codex', '--output', join(dir, 'out'), '--json'], deps())).toBe(0);
    const parsed = Bun.TOML.parse(await readFile(join(dir, 'out', 'codex', 'agents', 'reviewer.toml'), 'utf8')) as { model: string };
    expect(parsed.model).toBe(FIXTURE_MODEL_ID);
  });

  test('katalog źródłowy agentów i symlink do niego są odrzucane także z --force', async () => {
    const native = join(dir, 'project', '.opencode', 'agents');
    expect(await runCli(['config', 'export', '--client', 'opencode', '--output', native, '--force'], deps())).toBe(2);
    await symlink(native, join(dir, 'link'));
    expect(await runCli(['config', 'export', '--client', 'opencode', '--output', join(dir, 'link'), '--force'], deps())).toBe(2);
    expect(err.join('')).toContain('export-native-root');
  });

  test('kolizja artefaktu wymaga --force, a --dry-run niczego nie zapisuje', async () => {
    expect(await runCli(['config', 'export', '--client', 'opencode', '--output', join(dir, 'out'), '--dry-run', '--json'], deps())).toBe(0);
    await expect(readdir(join(dir, 'out'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await runCli(['config', 'export', '--client', 'opencode', '--output', join(dir, 'out')], deps())).toBe(0);
    expect(await runCli(['config', 'export', '--client', 'opencode', '--output', join(dir, 'out')], deps())).toBe(2);
    expect(await runCli(['config', 'export', '--client', 'opencode', '--output', join(dir, 'out'), '--force'], deps())).toBe(0);
  });
});

describe('dumpToml', () => {
  test('roundtrip przez Bun.TOML.parse dla obsługiwanego podzbioru', () => {
    const value = { name: 'reviewer', model: 'gateway/x y', enabled: true, depth: 2, tags: ['a', 'b'], limits: { max: 3 } };
    expect(Bun.TOML.parse(dumpToml(value))).toEqual(value);
  });

  test('nieobsługiwana wartość rzuca RouterError', () => {
    expect(() => dumpToml({ nested: { deeper: { x: 1 } } })).toThrow('export-unsupported-value');
  });
});
```

- [ ] **Step 3: Napisz failing test serve**

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../src/cli/serve';
import type { CliDeps, FetchLike } from '../../src/core/types';
import { startCaptureGateway } from '../support/capture-gateway';
import { FIXTURE_MODEL_ID, configFixture, snapshotFixture } from '../support/fixtures';

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'subagent-router-serve-'));
  await writeFile(join(dir, 'subagent-router.json'), JSON.stringify(configFixture()));
  await writeFile(join(dir, 'models.lock.json'), JSON.stringify(await snapshotFixture()));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('serve', () => {
  test('używa generacji z chwili startu i nie widzi późniejszej zmiany opisu', async () => {
    const gateway = await startCaptureGateway();
    const fetchLike: FetchLike = (request) => fetch(request);
    const deps: CliDeps = { cwd: dir, home: dir, env: { GATEWAY_URL: `${gateway.url}/v1`, GATEWAY_HEADERS: '{}', MODELS_AUTH: 't', ROUTER_SECRET: 's' }, stdout: () => {}, stderr: () => {}, isTTY: false, fetch: fetchLike, now: () => new Date() };
    const server = await startServer(join(dir, 'subagent-router.json'), deps, { port: 0, host: '127.0.0.1' });
    try {
      const changed = configFixture();
      changed.modelOverrides[FIXTURE_MODEL_ID] = { alias: 'quick', description: 'zmienione' };
      await writeFile(join(dir, 'subagent-router.json'), JSON.stringify(changed));
      const response = await fetch(`${server.url}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-haiku', system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_is_subagent=true' }], messages: [{ role: 'user', content: '<subagent-router v="1" model="fast"/>\nZadanie' }] }),
      });
      expect(response.status).toBe(200);
      expect(gateway.requests[0]?.model).toBe(FIXTURE_MODEL_ID);
      expect(typeof server.generation).toBe('string');
    } finally {
      await server.stop();
      await gateway.close();
    }
  });
});
```

- [ ] **Step 4: Szkielety i RED**

Szkielety: `describeModel` i `exportConfig` nic nie robią, `startServer` startuje serwer zwracający 501, `dumpToml` zwraca pusty ciąg. Uruchom trzy pliki testów; oczekiwane porażki na odczycie plików, kodach wyjścia i statusie 200.

- [ ] **Step 5: Zaimplementuj**

`describeModel`: `loadState`, rozwiąż referencję przez katalog albo, gdy snapshot zawiera ID ze statusem `missing`, przez `snapshot.models`; zapisz `modelOverrides[id].description` albo usuń klucz przy `null`, pozostawiając inne pola; `commitState` z `config`. `exportConfig`: rozwiąż `outputDir` przez `realpath` katalogu nadrzędnego i porównaj z realpath wszystkich roots natywnych (`cwd/.claude`, `home/.claude`, `cwd/.opencode`, `home/.config/opencode`, `cwd/.codex`, `home/.codex`, `CLAUDE_CONFIG_DIR`, `additionalRoots`); zbieżność lub zawieranie daje `RouterError('export-native-root')` niezależnie od `force`; istniejący plik artefaktu bez `force` daje `export-collision`; `dryRun` zwraca listę bez zapisu; zapis atomowy przez plik tymczasowy i `rename` w katalogu wyjściowym. Dla `opencode` użyj `opencodeVariants`; dla `codex` wygeneruj `codex/agents/<role>.toml` z `native` roli i `model` równym `routeOverride` oraz, przy `catalogRequired`, `codex/model_catalog.json` z aktywnych modeli. `startServer`: `loadState`, `resolveSource`, `validateSource`, `loadCapabilityProfile` dla wykrytej wersji z `env.SUBAGENT_ROUTER_CLAUDE_VERSION` albo profilu `pending`, `createHandler`, `Bun.serve({ hostname: host, port, fetch: handler })`; zwróć `url`, `generation` i `stop`. `doctor --connect`: `discoverModels` do pierwszej strony, raport `reachable` i `schemaValid`, bez zapisu snapshotu. `main.ts` dodaje tylko dispatch.

- [ ] **Step 6: GREEN i pełny zestaw**

```bash
bun test ./tests/cli/write.test.ts ./tests/cli/export.test.ts ./tests/cli/serve.test.ts && bun run typecheck && bun test
```

Oczekiwane: wszystkie pass, 0 fail globalnie.

- [ ] **Step 7: Commit**

```bash
git add src/cli/write.ts src/cli/serve.ts src/agents/export.ts src/cli/main.ts tests/cli
git commit -m "feat: add sync, describe, export and serve commands"
```

### Task 14: Jedna paczka, import rdzenia poza Bun i smoke CLI

**Files:**
- Create: `src/index.ts`
- Create: `src/bun.ts`
- Create: `scripts/build.ts`
- Modify: `package.json` (pola `exports`, `bin`, `files`)
- Test: `tests/package.test.ts`

**Interfaces:**
- Consumes: wszystkie moduły wcześniejszych zadań.
- Produces: eksport `./core` (`src/index.ts`: typy, `resolveRoute`, `buildCatalog`, `resolveModel`, `parseOperatorConfig`, `parseSnapshot`, `sha256`, `modelAlias`, `sourceFingerprint`, `RouterError`), eksport `./handler` (`createHandler`, `createClaudeStartOutput`), eksport `./bun` (`runCli`, `startServer`, adaptery, inventory); `bin.subagent-router` wskazuje `dist/cli.js`.

- [ ] **Step 1: Napisz failing test paczki**

```ts
import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');

function run(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: ROOT, env: { ...process.env, NO_COLOR: '1' } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

describe('package', () => {
  test('build tworzy dist z ESM i deklaracjami', async () => {
    const built = await run('bun', ['run', 'build']);
    expect(built.code).toBe(0);
    expect(await readFile(join(ROOT, 'dist', 'core.js'), 'utf8')).toContain('resolveRoute');
    expect(await readFile(join(ROOT, 'dist', 'types', 'index.d.ts'), 'utf8')).toContain('RouteDecision');
  });

  test('rdzeń importuje się w Node bez Bun i podejmuje decyzję', async () => {
    const script = `import('./dist/core.js').then(async (m) => { const alias = await m.modelAlias('gateway/fast-worker'); console.log(JSON.stringify({ alias, kind: typeof m.resolveRoute })); })`;
    const result = await run('node', ['--input-type=module', '-e', script]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ alias: 'm-6414d01405c95a7bd2b2a13b415d7685a1673f800ca90dd031a5eeb1776dc81d', kind: 'function' });
  });

  test('dist/core.js nie zawiera odwołań do Bun ani do node:fs', async () => {
    const core = await readFile(join(ROOT, 'dist', 'core.js'), 'utf8');
    expect(core.includes('Bun.')).toBe(false);
    expect(core.includes('node:fs')).toBe(false);
  });

  test('CLI odpowiada na --version i --help z kodem 0, a nieznana komenda kodem 2', async () => {
    expect((await run('bun', ['dist/cli.js', '--version'])).code).toBe(0);
    expect((await run('bun', ['dist/cli.js', '--help'])).stdout).toContain('models sync');
    expect((await run('bun', ['dist/cli.js', 'nope'])).code).toBe(2);
  });
});
```

- [ ] **Step 2: RED**

Bez `scripts/build.ts` polecenie `bun run build` kończy się błędem; test pada na `toBe(0)`. To jest porażka asercji na kodzie wyjścia, nie na imporcie modułu testowego.

- [ ] **Step 3: Zaimplementuj build i eksporty**

`scripts/build.ts` uruchamia `Bun.build` z trzema wejściami (`src/index.ts` do `dist/core.js`, `src/transport/handler.ts` do `dist/handler.js`, `src/bun.ts` do `dist/cli.js` z `target: 'bun'` i shebangiem `#!/usr/bin/env bun`), `target: 'node'` dla rdzenia i handlera, `format: 'esm'`, bez `splitting`; następnie `Bun.spawn(['bunx', 'tsc', '-p', 'tsconfig.json'])` dla deklaracji. `package.json` dodaje `exports` z `./core`, `./handler`, `./bun`, pole `bin`, `files: ['dist']`, `sideEffects: false`. `src/bun.ts` wywołuje `runCli(process.argv.slice(2), realDeps())` tylko gdy `import.meta.main`.

- [ ] **Step 4: GREEN**

```bash
bun test ./tests/package.test.ts && bun run typecheck && bun test
```

Oczekiwane: 4 pass w pliku, 0 fail globalnie. Katalog `dist` jest w `.gitignore`.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/bun.ts scripts/build.ts package.json .gitignore tests/package.test.ts
git commit -m "build: package core, handler and CLI entrypoints"
```

### Task 15: Bramka integracji, pomiary M1 do M10 i dokumentacja bloków

**Files:**
- Create: `tests/e2e/routing.test.ts`
- Create: `tests/e2e/cli-workflow.test.ts`
- Create: `docs/core/README.md`, `docs/core/CONTRACTS.md`, `docs/core/INVARIANTS.md`, `docs/core/GAPS.md`, `docs/core/OPERATIONS.md`
- Create: analogiczne pięć plików w `docs/catalog`, `docs/agents`, `docs/transport`, `docs/cli`
- Modify: `docs/README.md`, `README.md`
- Modify: `tests/fixtures/capabilities/*.json` (wyłącznie wyniki rzeczywistych prób)

**Interfaces:**
- Consumes: całość paczki, `startCaptureGateway`, `tests/probes/run.ts`.
- Produces: hermetyczny test E2E na fake gateway, opt-in test na prawdziwych harnessach, macierz wsparcia i dokumentacja bloków z rzeczywistym zakresem dowodów.

- [ ] **Step 1: Napisz hermetyczny test E2E**

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../src/cli/serve';
import type { CliDeps } from '../../src/core/types';
import { startCaptureGateway } from '../support/capture-gateway';
import { configFixture, snapshotFixture } from '../support/fixtures';

const CHILD_SYSTEM = [{ type: 'text', text: 'x-anthropic-billing-header: cc_is_subagent=true' }];
let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'subagent-router-e2e-'));
  const config = configFixture();
  config.modelOverrides['gateway/model B'] = { alias: 'b', description: 'B' };
  config.modelOverrides['gateway/Model-C'] = { alias: 'c', description: 'C' };
  await writeFile(join(dir, 'subagent-router.json'), JSON.stringify(config));
  await writeFile(join(dir, 'models.lock.json'), JSON.stringify(await snapshotFixture(['gateway/fast-worker', 'gateway/model B', 'gateway/Model-C'])));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

describe('e2e routing przez fake gateway', () => {
  test('rodzic A oraz równoczesne dzieci B i C trafiają do właściwych modeli, marker nie wycieka', async () => {
    const gateway = await startCaptureGateway();
    const deps: CliDeps = { cwd: dir, home: dir, env: { GATEWAY_URL: `${gateway.url}/v1`, GATEWAY_HEADERS: '{}', MODELS_AUTH: 't', ROUTER_SECRET: 's' }, stdout: () => {}, stderr: () => {}, isTTY: false, fetch: (r) => fetch(r), now: () => new Date() };
    const server = await startServer(join(dir, 'subagent-router.json'), deps, { port: 0, host: '127.0.0.1' });
    try {
      await Promise.all([
        post(server.url, { model: 'claude-opus', messages: [{ role: 'user', content: 'rodzic' }] }),
        post(server.url, { model: 'claude-haiku', system: CHILD_SYSTEM, messages: [{ role: 'user', content: '<subagent-router v="1" model="b"/>\nB' }] }, { 'x-claude-code-agent-id': 'agent-b' }),
        post(server.url, { model: 'claude-haiku', system: CHILD_SYSTEM, messages: [{ role: 'user', content: '<subagent-router v="1" model="c"/>\nC' }] }, { 'x-claude-code-agent-id': 'agent-c' }),
      ]);
      const models = gateway.requests.map((r) => r.model).sort();
      expect(models).toEqual(['claude-opus', 'gateway/Model-C', 'gateway/model B']);
      expect(JSON.stringify(gateway.requests.map((r) => r.body))).not.toContain('subagent-router');
    } finally {
      await server.stop();
      await gateway.close();
    }
  });

  test('dziecko wykonuje roundtrip narzędzia i zwraca zdekodowany wynik z tego samego modelu', async () => {
    const gateway = await startCaptureGateway();
    const deps: CliDeps = { cwd: dir, home: dir, env: { GATEWAY_URL: `${gateway.url}/v1`, GATEWAY_HEADERS: '{}', MODELS_AUTH: 't', ROUTER_SECRET: 's' }, stdout: () => {}, stderr: () => {}, isTTY: false, fetch: (r) => fetch(r), now: () => new Date() };
    const server = await startServer(join(dir, 'subagent-router.json'), deps, { port: 0, host: '127.0.0.1' });
    try {
      const first = await post(server.url, { model: 'claude-haiku', system: CHILD_SYSTEM, messages: [{ role: 'user', content: '<subagent-router v="1" model="b"/>\nUżyj narzędzia' }], tools: [{ name: 'echo', input_schema: { type: 'object' } }] }, { 'x-claude-code-agent-id': 'agent-b' });
      const firstBody = (await first.json()) as { content: Array<{ type: string }> };
      const second = await post(server.url, { model: 'claude-haiku', system: CHILD_SYSTEM, messages: [
        { role: 'user', content: '<subagent-router v="1" model="b"/>\nUżyj narzędzia' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'echo', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'wynik' }] },
      ] }, { 'x-claude-code-agent-id': 'agent-b' });
      expect(second.status).toBe(200);
      expect(gateway.requests.map((r) => r.model)).toEqual(['gateway/model B', 'gateway/model B']);
      expect(firstBody.content.length).toBeGreaterThan(0);
    } finally {
      await server.stop();
      await gateway.close();
    }
  });
});
```

Test pokazuje ID ze spacją i z wielką literą; brama musi odebrać je bez zmian. Roundtrip narzędzia w tej wersji jest syntetyczny: sprawdza, że oba requesty dziecka idą do tego samego modelu i że odpowiedź jest dekodowalna. Prawdziwy roundtrip wykonuje test opt-in.

- [ ] **Step 2: Napisz test przepływu CLI**

`tests/e2e/cli-workflow.test.ts` uruchamia sekwencję `models sync` (fake fetch), `models describe`, `route preview`, `config check`, `config export --dry-run` w katalogu tymczasowym i sprawdza: preview po sync widzi nowy model, po describe widzi opis, generacja zmienia się po każdym zapisie, a `config export --dry-run` nie tworzy plików. Każdy krok asercji odczytuje pliki z dysku, nie stan w pamięci.

- [ ] **Step 3: Zaobserwuj wyniki i napraw tylko przez cykle TDD**

```bash
bun test ./tests/e2e
```

Oczekiwane: pass. Każda porażka jest usterką w zadaniu 1 do 14 i wraca do tego zadania jako nowy test RED, nie jako poprawka w teście E2E.

- [ ] **Step 4: Test opt-in na prawdziwych harnessach**

Test uruchamiany tylko przy `SUBAGENT_ROUTER_E2E=1` i obecności binariów. Dla każdego klienta: izolowany katalog konfiguracji, brama capture, `serve`, uruchomienie harnessu w trybie nieinteraktywnym z promptem, który deleguje do syntetycznego subagenta i każe mu wywołać narzędzie odczytu pliku z fixture. Kryteria: brama odebrała request dziecka z `upstreamModel` z katalogu, dziecko wykonało narzędzie (widoczny `tool_result` w kolejnym requeście dziecka) i wynik końcowy rodzica zawiera treść pliku. Test raportuje wersje `claude --version`, `opencode --version`, `codex --version` i bramy w stdout. Test nie zapisuje sekretów i nie modyfikuje `HOME` operatora. Brak binarium daje `test.skip` z komunikatem, nie pass.

- [ ] **Step 5: Wykonaj pomiary i zapisz profile**

Uruchom `tests/probes/run.ts` dla M1, M2, M3, M4 (Claude Code), M6 (OpenCode), M5, M7, M9 (Codex) oraz M10 (każdy klient). Codex wymaga wcześniejszej aktualizacji do wydania co najmniej rust-v0.153.4; bez niej wyniki Codex pozostają `pending`, a adapter odmawia działania. Wyniki zapisz do `tests/fixtures/capabilities/<client>-<version>.json` z datą i wersją. Zmiana `status` na `supported` wymaga zaliczonego `M10` i, dla Claude Code, `M3` albo działającego kanału B2. `correlation: true` wymaga zaliczonego M1. `fork: true` wymaga zaliczonego M4 i osobnego testu E2E forka; do tego czasu fork pozostaje pass-through zgodnie z D3.

- [ ] **Step 6: Napisz dokumentację bloków**

Każdy z pięciu bloków (`core`, `catalog`, `agents`, `transport`, `cli`) dostaje `README.md` z YAML `block`, `doc`, `verified_against` (SHA commitu po Task 15), `verified_on`, `owns` i `depends_on`; `CONTRACTS.md` z polem `enforcement:` wskazującym plik testu; `INVARIANTS.md`; `GAPS.md` z listą pomiarów `pending` i `failed`; `OPERATIONS.md` z komendami. Fakty oznaczaj `[verified]`, `[inferred]`, `[assumption]`. Macierz wsparcia w `docs/README.md`: klient, wersja, status, wynik każdego pomiaru, korelacja, fork. `README.md` dostaje instrukcję instalacji dopiero teraz, z zastrzeżeniem statusów `pending`.

- [ ] **Step 7: Pełna weryfikacja i commit**

```bash
bun run typecheck && bun test && bun run build
```

Oczekiwane: 0 fail. Następnie:

```bash
git add tests/e2e tests/fixtures/capabilities docs README.md
git commit -m "test: add e2e gates and document verified blocks"
```

- [ ] **Step 8: Przegląd całej gałęzi**

Po ostatnim commicie koordynator uruchamia niezależny przegląd zakresu od bazy planu do HEAD. Reviewer sprawdza zgodność ze spec, wynik pomiarów, brak sekretów w fixtures i dokumentacji oraz to, że żaden adapter nie ma statusu `supported` bez dowodu. Merge do `main`, push i publikacja paczki wymagają osobnej zgody użytkownika.

## Mapa pokrycia specyfikacji

Ta mapa pokazuje miejsce implementacji, nie zaliczenie testów. Wykonawca uzupełnia dowody w ledgerze dopiero po uruchomieniu wskazanych przypadków.

| Wymagania normatywne | Zadania | Obserwowalny wynik |
|---|---|---|
| 1-4 | 1, 14 | Jedna paczka, import core w Node bez Bun i bez efektów ubocznych |
| 5-8 | 4, 5, 12, 13, 14 | Małe CLI, eksport poza native roots, brak SDK dostawców, brak request-time discovery |
| 9-17 | 2, 3, 6, 8, 10, 11 | Jawny wybór z katalogu, walidacja, zachowany model i uprawnienia rodzica |
| 18-23 | 3, 8, 9, 10, 11 | Priorytety i konflikt dają dokładny wynik lub widoczny błąd, bez fallbacku |
| 24-30 | 3, 7, 8, 15 | Rozdzielone modele, oddzielny probe forka bez fałszywej gwarancji |
| 31-33 | 7, 10, 11, 15 | Natywny model podlega kontroli runtime, certyfikat wersji wynika z dowodów |
| 34-43 | 8, 9, 13, 15 | Embed i serve używają tego samego handlera, stream i abort są propagowane |
| 44-47 | 2, 5, 9, 15 | Zmiana skonfigurowanego endpointu nie zmienia logiki dostawcy |
| 48-51 | 2, 3, 5, 12, 13 | Brak opisu ukrywa sugestię, nie definiuje ręcznie modelu; missing/disabled nie routują |
| 52 | 6, 8, 10, 11, 13, 15 | Hash natywnych definicji nie zmienia się, także dla inherit i symlinków |
| 53 | 4, 12, 13, 14 | Offline JSON, poprawne kody, konflikt równoległych zapisów bez utraty danych |

| Kryteria akceptacji spec | Zadania |
|---|---|
| 1-3 | 7, 8, 9, 10, 11, 15 |
| 4-5 | 3, 8, 9, 15 |
| 6-7 | 7, 8, 9, 10, 11, 15 |
| 8 | 2, 3, 8, 9, 10, 11, 15 |
| 9 | 9, 15 |
| 10 | 1, 14 |
| 11-12 | 5, 7, 9, 15 |
| 13 | 2, 12 |
| 14 | 6, 10, 11, 13, 15 |
| 15-18 | 1, 2, 4, 5, 13 |
| 19 | 6, 12 |
| 20-21 | 12, 14, 15 |
| 22 | 4, 13 |
| 23 | 2, 8, 13 |
| 24 | 2, 4, 5, 13 |
| 25 | 2, 6, 10, 13 |
| 26 | 9, 12, 13, 15 |

| Pomiar | Zadania | Kiedy blokuje |
|---|---|---|
| M1 | 7, 8, 15 | Włączenie korelacji Claude |
| M2 | 7, 8, 15 | Użycie pełnego natywnego model ID w danej wersji |
| M3 | 7, 8, 9, 15 | Wybrana ścieżka przekazania domyślnej roli |
| M4 | 7, 8, 15 | Deklaracja obsługi forka |
| M5 | 7, 11, 13, 15 | Eksport i użycie katalogu Codex |
| M6 | 6, 7, 10, 13, 15 | Deklaracja obsługi wariantów OpenCode |
| M7 | 7, 11, 15 | Cały adapter Codex tej wersji |
| M8 | 15 | Pomiar informacyjny, nie gate; wymagany opis obserwacji |
| M9 | 7, 11, 15 | Jawny model połączony z rolą Codex |
| M10 | 7, 9, 10, 11, 15 | Deklaracja wspieranego przejścia lifecycle |

| Decyzja spec | Zadania |
|---|---|
| D1 | 3, 7, 8, 9, 10, 11 |
| D2 | 3, 7, 8, 9 |
| D3 | 7, 8, 15 |
| D4 | 1, 2, 4, 5, 12, 13 |
| D5 | 6, 7, 10, 13, 15 |
| D6 | 6, 7, 11, 13, 15 |
| D7 | 3, 8, 12, 15 |
| D8 | 7, 12, 14, 15 |
| D9 | 6, 8, 10, 11, 12, 13 |
| D10 | 2, 4, 5, 12, 13 |
| D11 | 12, 13, 14, 15 |

## Warunek zakończenia wykonania

- [ ] Wszystkie implementowane zachowania mają zaobserwowany RED i GREEN, potem review zgodności oraz jakości.
- [ ] Pakiet działa jako import core poza Bun oraz jako CLI w wymaganej wersji Bun.
- [ ] Wskazana macierz klientów zawiera rzeczywiste wersje, wyniki probe i status każdego przejścia lifecycle.
- [ ] Pending lub unsupported nie jest raportowany jako pełna obsługa klienta. Jeśli nie udało się włączyć części adaptera, wynik wdrożenia jest jawnie częściowy.
- [ ] Szeroki przegląd obejmuje zakres od MERGE_BASE do HEAD, nie tylko ostatni commit.
- [ ] Dokumentacja bloków podaje rzeczywiste commity i wyniki. Zwróć wszystkie rozstrzygnięcia ledgeru z kosztem pomyłki.
- [ ] Merge, push i publikacja są osobnymi działaniami wymagającymi zgody użytkownika.

---

