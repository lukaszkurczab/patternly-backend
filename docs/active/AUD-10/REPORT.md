# AUD-10 — raport

**Status:** `done` dla zakresu lokalnej konfiguracji backendu  
**Data:** 2026-09-23  
**Model walidacji briefingu:** `gpt-6-luna/high` — zgodność 0,95; prostota 0,95; ryzyko 0,90; utrzymywalność 0,93; minimum 0,90.

## Zmiana

`loadEnvironment` odrzuca obecność `FIREBASE_AUTH_EMULATOR_HOST` albo `FIRESTORE_EMULATOR_HOST` w `NODE_ENV=production`, przed utworzeniem Firebase runtime. Odrzucenie obejmuje także pustą wartość. Błąd `production_firebase_emulator_config_forbidden` nie ujawnia wartości konfiguracji. Profil `test` z jawnymi hostami emulatorów pozostaje obsługiwany.

## Weryfikacja

- `node --import tsx --test tests/environment.test.ts` — **2/2 PASS**. Macierz sprawdza poprawną konfigurację production bez hostów, każdy host osobno i razem, wartości loopback/remote/puste oraz profil lokalny z dwoma emulatorami.
- `npm run typecheck` — **PASS**.
- `git diff --check` — **PASS**.
- Nie uruchamiano backendu ani emulatorów.

## Zakres i pozostałe bramki

Zmodyfikowano `src/config/environment.ts` i dodano `tests/environment.test.ts`. Nie zmieniono inicjalizacji SDK ani profilu lokalnego. To zamyka wyłącznie AUD-10; nie jest globalnym gate ani dowodem produkcyjnego deployu.
