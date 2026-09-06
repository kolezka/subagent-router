# Konwencje dokumentacji

Ten dokument opisuje lekkie zasady dla dokumentacji `subagent-router`. Dotyczy stanu projektowanego i później także stanu wdrożonego.

## Statusy

Każdy spec, plan lub dokument bloku podaje w treści `Date` i `Status`.

- `draft`: materiał do przeglądu, bez zatwierdzenia.
- `approved`: decyzja zaakceptowana, ale nie musi być wdrożona.
- `implemented`: opis odpowiada działającemu zachowaniu zweryfikowanemu względem wskazanego kodu i testów.
- `superseded`: materiał zastąpiony przez nowszy dokument, z linkiem do następcy.

Zadania należą do planu, nie do specyfikacji. Planów nie tworzy się przed zatwierdzeniem specyfikacji.

## Fakty, założenia i wymagania

Dokumentacja oznacza poziom podstawy każdego istotnego twierdzenia:

- `[verified]`: potwierdzone we wskazanym źródle lub wykonanym sprawdzeniu. Odczyt kodu nie oznacza testu działającej integracji.
- `[inferred]`: wniosek z potwierdzonych faktów, z podanym uzasadnieniem.
- `[assumption]`: założenie lub informacja niezweryfikowana w źródle.
- `[historical: YYYY-MM-DD, źródło]`: dawny pomiar, którego nie można teraz odtworzyć. Sam wiek dokumentu nie uzasadnia tego oznaczenia.

Wymagania normatywne są pisane osobno, zwykle jako `MUSI`, `NIE MOŻE` lub `POWINIEN`. Nie należy przedstawiać ich jako zmierzonych faktów.

Dla początkowych dokumentów meta nie dodajemy YAML ani pola `verified_against`, ponieważ nie istnieje implementacja, którą można uczciwie wskazać.

## Dowody i kontrakty

Każdy przyszły opis działającego bloku zawiera YAML z polami `block`, `doc`, `verified_against` i `verified_on`. Wartość `verified_against` jest identyfikatorem sprawdzonego commita. Cytowania w treści wskazują plik i symbol, nie numer linii.

Opis działania oddziela:

- kontrakt publiczny,
- invariants, które kod i testy muszą zachować,
- luki i nieweryfikowane ścieżki,
- mechanizm enforcementu, który faktycznie istnieje,
- elementy wyłącznie planowane.

Nie wolno kopiować pola weryfikacji do dokumentu, którego nie sprawdzono względem działającego kodu.

## Struktura i linki

`docs/README.md` jest indeksem. Specyfikacje zapisuje się jako `docs/superpowers/specs/YYYY-MM-DD-<slug>-design.md`. Przyszłe plany zapisuje się jako `docs/superpowers/plans/YYYY-MM-DD-<slug>.md`.

Linki wewnątrz repo są względne. Zewnętrzne źródła używają pinned commit, gdy odwołują się do kodu. Cytowania wskazują symbol, commit i plik, bez numerów linii.

## Styl

Nowa proza dokumentacji jest po polsku. Identyfikatory, nazwy plików, nazwy symboli i wartości techniczne pozostają po angielsku, gdy są częścią kontraktu lub źródła.

Źródłem adaptowanego stylu jest [dotfiles-next, commit `9337ab95a2fa3f673e77d16aa2be720e7b8353b1`](https://github.com/kolezka/dotfiles-next/tree/9337ab95a2fa3f673e77d16aa2be720e7b8353b1/docs). Konwencja została uproszczona dla projektu bez implementacji i nie przenosi automatycznie jego faktów ani struktury.
