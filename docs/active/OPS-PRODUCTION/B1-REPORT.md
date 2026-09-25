# OPS-PRODUCTION/B1 — tożsamość i allowlista operatora

**Status:** `done / independent QA PASS WITH ISSUES`  
**Zakres:** backend lokalnie; bez tras domenowych B2, CLI B3, docelowej konfiguracji C i wdrożenia.  
**Baza:** `patternly-backend` `3c759555`; kontrakt A: `patternly` `250621ef`.

## Wynik

B1 dostarcza osobny, opcjonalny profil OIDC operatora. Brak całej konfiguracji oznacza `unavailable`; konfiguracja częściowa lub błędna zatrzymuje bootstrap. Profil nie używa Firebase Auth jako fallbacku i nie zmienia istniejących guardów mobile/admin.

- `OPERATOR_OIDC_ISSUER`, `OPERATOR_OIDC_AUDIENCE`, `OPERATOR_OIDC_JWKS_URL` i `OPERATOR_ALLOWLIST_JSON` są all-or-none.
- Allowlista ma unikalny subject, rolę i zamknięty zbiór jawnych akcji. Nie obsługuje wildcardów ani dodatkowych pól.
- Token wymaga `RS256`, `kid`, dokładnego `iss/aud/sub`, poprawnego `exp/iat` oraz opcjonalnego `nbf`; podpis jest sprawdzany kluczem z JWKS.
- Wynik zawiera wyłącznie pseudonim HMAC, rolę i zatwierdzoną akcję. Błędy są ujednolicone do `operator_token_invalid` bez tokenu lub subjectu.
- Produkcyjny loader JWKS używa HTTPS bez redirectów, jednego deadline’u dla DNS/TLS/headers/body, limitu 256 KiB oraz custom DNS lookup. Ten sam socket dostaje wyłącznie sprawdzony publiczny adres; pusty lub mieszany public/private zestaw jest odrzucany.
- Cache respektuje `max-age` do 3600 s. Jedno współdzielone odświeżenie i globalny cooldown ograniczają nieznane — także rotujące — `kid`, również gdy refresh kończy się błędem.
- `index.ts` konstruuje zależność i przekazuje ją do aplikacji. B1 celowo nie dodaje konsumenta HTTP; guard i endpointy należą do B2.

## Briefing i QA

Briefing Luna High: spójność `0,92`, prostota `0,84`, kontrola ryzyka `0,86`, utrzymywalność `0,84`; minimum `0,84`, `APPROVE`.

QA wykonało cztery iteracje. Pierwsze trzy `FAIL` ujawniły kolejno: nieograniczony odczyt/body i refresh amplification; DNS TOCTOU; niepoprawny callback Node 22 dla `lookup(all:true)`. Wszystkie przyczyny usunięto. Końcowy werdykt: `PASS WITH ISSUES`.

## Weryfikacja

- Testy ukierunkowane po finalnej poprawce: `12/12 PASS`.
- `lint`, `typecheck`, `build`, `git diff --check`: `PASS`.
- Pełny suite przed przebudową produkcyjnego loadera: `239/239 PASS`.
- Pełny suite po finalnym loaderze: `240/241`; jedyny błąd to istniejący test `Firestore transaction preserves sync CAS and idempotency under concurrent retries`, który dwukrotnie dostał `500` na współdzielonym emulatorze. Zmiana B1 nie dotyka progress ani Firestore, więc wynik jest zapisany jako nierozstrzygnięty problem środowiska/testu, a nie pełny PASS.

## Otwarte granice

- Prawdziwy endpoint JWKS i token nie były używane; to część późniejszej konfiguracji/C. Produkcyjną ścieżkę HTTPS sprawdzono źródłowo oraz testem formatu callbacku DNS, nie sieciowym E2E.
- Zwykły cold/expired-cache refresh podczas awarii JWKS może zostać ponowiony przez kolejny request; nieznane `kid` mają osobny globalny cooldown. Backend pozostaje fail-closed.
- Brak routów operatorskich jest zamierzony. B2 musi użyć `operatorTokenVerifier` bez modyfikowania lokalnego admina i bez fallbacku do Firebase.

## Następny slice

`OPS-PRODUCTION/B2`: operator guard oraz allowlistowane list/detail/action oparte na istniejących store’ach, wraz z `expectedStatus` dla content reports i istniejącymi `expectedRevision` dla pozostałych rodzin.
