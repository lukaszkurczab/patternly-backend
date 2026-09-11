# GATE-02 — report

Status: `done`

Backend OpenAPI jest wykonywalnym kontraktem 54 aktywnych operacji: wymusza unikalne `operationId`, jawne security/consumer metadata, kompletne parametry oraz zamknięte request, success-response i error schemas. Runtime Fastify jest porównywany z OpenAPI po metoda+ścieżka, a behawioralne probe'y dowodzą ochrony bearer, App Check, admin i webhook. Checker wszystkich transportów mobile/web wiąże 46 faktycznie używanych operacji po metodzie i znormalizowanej ścieżce; 8 operacji jest jawnie backend-only, 3 diagnostyczne.

Usunięto zastąpiony path-string grep oraz przejściowe generyczne fallbacki i drugi katalog tras. Znalezione podczas QA rozjazdy account deletion, admin legal request, purchase response i schematy strict zostały poprawione. OpenAPI pozostaje jedynym katalogiem endpointów, a JSON jest deterministycznym artefaktem.

Weryfikacja:

- briefing Luna/max: PASS `0,92 / 0,86 / 0,88 / 0,90`;
- `node --import tsx --test tests/openapiContracts.test.ts`: `20/20`;
- pełny backend test na działających emulatorach: `153/153`;
- `firestore:ttl:check`, `openapi:check` z Ajv2020 i security probes, `frontend:client:check`, lint, typecheck, build oraz `git diff --check`: PASS;
- niezależne QA po dwóch pętlach naprawczych: finalny PASS, brak otwartych problemów.

Pierwsze uruchomienie `npm run ci` nie wystartowało drugiej instancji Firebase Emulator Suite, ponieważ porty `19099` i `18081` były zajęte przez działającą instancję. Ten sam wymagany zestaw wykonano na tej instancji (`153/153`), a wszystkie pozostałe etapy `ci` uruchomiono osobno z wynikiem PASS. Residual risk: security probes dowodzą granic uwierzytelnienia/autoryzacji, a zachowanie biznesowe pozostaje pokryte istniejącymi testami modułów i emulatorów.
