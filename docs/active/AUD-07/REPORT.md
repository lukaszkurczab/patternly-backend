# AUD-07 — Integralność paczki progress sync

**Data:** 2026-09-23  
**Status:** done

## Cel

Nie dopuścić, by jedna paczka sync zawierała powtórzone `mutationId` lub więcej niż jedną mutację dla tego samego rekordu. Błąd walidacji musi nastąpić przed rozpoczęciem transakcji Firestore.

## Ustalenia i decyzja

Poprzednia walidacja akceptowała oba przypadki. Firestore zwracał błąd dla powtórzonych identyfikatorów mutacji, a różne mutacje do tego samego celu mogły być kolejno stosowane, podnosząc rewizję i pozostawiając ostatni zapis. Kanoniczny `syncRequestSchema` otrzymał kontrolę unikalności `mutationId` oraz klucza celu `JSON.stringify([recordType, trackId, targetId])`. Nie zmieniono protokołu, kształtu danych ani atomowego CAS.

Ocena przed wdrożeniem: zgodność z celem **0.95**, prostota **0.93**, ryzyko **0.88**, utrzymywalność **0.92**; minimum **0.88**. Niezależny briefing Luna High zatwierdził tę decyzję.

## Zmiany

- `src/modules/progress/contracts.ts`: duplikaty są raportowane jako błędy Zod przy indeksie kolidującej mutacji.
- `tests/progressContracts.test.ts`: testy identyfikatorów, celów i niezależności od innego tracku/celu.
- `tests/firestore.emulator.test.ts`: weryfikacja HTTP 400, braku zapisów do progress/syncMutations/syncBatches/account metadata oraz zastosowania dwóch różnych celów.
- Istniejący test CAS, równoległych retry i idempotentnego replay pozostaje bez zmian.

## Weryfikacja lokalna

- `node --import tsx --test tests/progressContracts.test.ts` — **9/9 PASS**.
- Na wcześniej uruchomionych emulatorach Auth i Firestore: `node --import tsx --test tests/firestore.emulator.test.ts` — **31/31 PASS**.
- `git diff --check` — czysty.

## Ograniczenia

Nie wykonano pełnego `npm test` ani pełnego smoke end-to-end aplikacji dla AUD-07; test emulatora obejmuje cały plik `firestore.emulator.test.ts`, a aktywne lokalne API i aplikacja pozostały uruchomione.
