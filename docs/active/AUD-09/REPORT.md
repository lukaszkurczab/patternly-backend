# AUD-09 — stan niedostarczenia kodu privacy i bezpieczny resend

**Status:** `done` lokalnie; brak wysyłki do zewnętrznego transportu i pełny release gate poza zakresem  
**Data:** 23 września 2026  
**Repozytoria:** `patternly`, `patternly-backend`

## Kontrakt i zmiany

- API publiczne zachowuje neutralne `202 pending_verification` po przyjęciu wniosku i resendzie. Odpowiedź nie zdradza awarii sendera ani tego, czy ID/adres pasuje.
- Backend nadal rejestruje `verification_email_failed` wewnętrznie po wyjątku transportu. Idempotentny create z tym samym `clientRequestId` zwraca ten sam wniosek; istniejący resend może wysłać nowy, ważny kod i wyczyścić wewnętrzny błąd dostawy. Limity resend pozostają bez zmian.
- Tekst PL/EN na ekranie mówi teraz, że wniosek zapisano, ale dostarczenie e-maila nie jest potwierdzone. Instrukcja formularza mówi, że kod może zostać wysłany; ekran nie obiecuje, że wiadomość dotarła.
- OpenAPI i wygenerowany `openapi/patternly-v1.json` usuwają nieosiągalne 503 „Email sender unavailable” dla create/resend i wyjaśniają neutralną odpowiedź.
- Fixture emulatorowy otrzymał opcjonalny `projectId`; nowy test tworzy losową przestrzeń projektu i jej nie czyści. Sprawdza wyjątek sendera, zapis wewnętrznej porażki, neutralną odpowiedź dla idempotentnego create i równoważną odpowiedź dla brakującego ID/złego e-maila, resend tego samego wniosku oraz użycie nowego kodu.

## Niezależna ocena i QA

Briefing-only `gpt-6-luna` / `high` zatwierdził wąski kontrakt: zgodność `0.93`, prostota `0.91`, akceptowalność ryzyka `0.88`, utrzymywalność `0.90`; minimum `0.88`. Nie inspekcjonował repozytorium.

Niezależny QA `gpt-6-luna` / `high` wskazał początkowo niezgodność OpenAPI (`503`) i brak raportu; oba problemy oraz późniejsze rozbieżności kolejki zostały poprawione. Końcowy QA `gpt-6-luna` / `high`: **PASS**. Potwierdzono spójność planu, raportu, OpenAPI i implementacji; nie uruchamiano testów destrukcyjnych na wspólnej przestrzeni ani nie dotykano SMTP/usług.

## Weryfikacja

- Przy sprawdzeniu przed testem Auth i Firestore emulatory nadal słuchały na 19099/18081; nie restartowano ich.
- `FIRESTORE_EMULATOR_HOST=127.0.0.1:18081 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:19099 node --import tsx --test tests/privacyRequestDelivery.emulator.test.ts` — PASS 1/1 w losowym projekcie emulatora. Nie dotykał wspólnej przestrzeni danych.
- `node --import tsx --test src/features/home/guestPrivacyDeliveryCopy.test.ts src/features/home/guestPrivacyDraft.test.ts` — PASS 2/2.
- `npm run typecheck`, `npm run lint`, `npm run openapi:check`, `git diff --check` w backendzie — PASS po wygenerowaniu OpenAPI.
- Parsowanie JSON locale PL/EN — PASS.
- Pełny `npm test` nie został użyty do odbioru: emulatorowe `privacyRequests.test.ts` wywołuje `clearFirestore()` na współdzielonym projekcie. Pierwsza pomyłkowa próba runnera bez wymaganych zmiennych emulatora zakończyła się 10 błędami setupu `firebase_emulator_suite_required`; nie modyfikowała danych.
- Mobilny `npm run typecheck` pozostaje czerwony na wcześniejszych, niepowiązanych brakach w `AccountEntryScreen.tsx` (`AccountCopy.accountDescription`, `InfoBlockProps.body`); `HEAD` zawiera te same referencje.
- Nie wysyłano SMTP ani wiadomości do osób. Nie uruchamiano ani nie resetowano API, usług, aplikacji, symulatora ani danych istniejącej przestrzeni Firebase.

## Niezależny QA

Niezależna kontrola finalna `gpt-6-luna` / `high` wydała **PASS** po korekcie OpenAPI i synchronizacji planu/raportu.

## Ocena podejścia

Zgodność `0.93`, prostota `0.91`, akceptowalność ryzyka `0.88`, utrzymywalność `0.90`; minimum `0.88`. Delivery error pozostaje serwerowy, żeby nie osłabić anti-enumeration; UI komunikuje neutralny stan oczekiwania i dostępny resend.
