# AUD-08 — raport postępu

**Status:** `blocking` — niezależne briefingi nie zatwierdziły bezpiecznego klient/server recovery contractu  
**Data:** 2026-09-23

## Potwierdzona luka

`FirestoreAccountLifecycleStore.consumeRecoveryCode` zapisuje `usedAt` w transakcji przed `revokeRefreshTokens` i `createCustomToken`. Lokalne failure injection na Firestore emulatorze z nowymi syntetycznymi identyfikatorami potwierdziło:

- błąd revoke → retry zwraca `recovery_code_used`;
- błąd mint → retry zwraca `recovery_code_used`.

Wynik historycznego runu: [`backend-failure-probes.json`](../../../../evidence/audit-2026-09-22/continuation/backend-failure-probes.json); kod próby: [`backend-failure-probes.mts`](../../../../evidence/audit-2026-09-22/continuation/backend-failure-probes.mts). Nie wykonano global clear emulatora.

## Walidacja podejścia

Pierwszy briefing proponował `operationId`, trwały stan processing i ponawianie provider calls bez zapisu custom tokenu. `gpt-6-luna/high` ocenił: zgodność 0,74; prostota 0,68; ryzyko 0,48; utrzymywalność 0,62; minimum **0,48**. Podejście niezaakceptowane.

Zidentyfikowane braki: brak wyłączności dla współbieżnego tego samego `operationId`, brak odzyskania `processing` po crashu bezpiecznego wobec spóźnionego workera, i nieuzgodnione zachowanie po utworzeniu tokenu, lecz utracie odpowiedzi HTTP. Bez przechowania chronionego wyniku ukończone retry nie może odtworzyć tego samego tokenu; przechowywanie tokenu zmienia profil ochrony sekretu.

## Odblokowanie

Przed implementacją uzgodnić jednoznaczny kontrakt: stabilny client `operationId`; odpowiedź dla równoległego duplikatu (np. `in-progress`); wyłączność provider call i odzyskanie crash-rezerwacji z fencing; zachowanie po provider failure; oraz politykę po utracie odpowiedzi po mint (bezpieczne trwałe przechowanie tego samego wyniku albo odmowa retry po ukończeniu). Następnie niezależny briefing Luna High musi osiągnąć minimum 0,8.

## Kontynuacja niezależna — 23 września

Stan repozytoriów przed rozważeniem zmiany: backend `main` `0ecb43f`, aplikacja `main` `80ec9db0`; oba mają niezwiązane, istniejące zmiany, które należy zachować. Backend nie ma własnego `AGENTS.md`. Źródłami były aktualne `consumeRecoveryCode`, endpoint, kontrakty, test emulatora, mobile caller, reissue/deletion flow, env/config, TTL policy oraz historyczne syntetyczne probes. Nie uruchamiano usług ani testów.

Pierwszy nowy briefing Luna High (propozycja: code hash jako stabilny operation identity, phase/lease/fence, osobny zaszyfrowany wynik) uzyskał: architektura 0,72; prostota 0,75; ryzyko 0,58; utrzymywalność 0,70; minimum **0,58** — odrzucono. Niezależny validator wykazał, że Firestore fencing nie wycofuje już trwającego wywołania Firebase, reissue/deletion mogą ścigać provider call, nieobsłużony success-before-persist może mintować ponownie, token renewal/revoke nie ma potwierdzonej semantyki, a osobne kody tej samej osoby nie były serializowane.

Po sprawdzeniu bieżącej oficjalnej dokumentacji Firebase przygotowano drugi briefing z trwałym ACK klienta, blokadą per-user, osobnym kluczem AES-GCM i wygaśnięciem. Oficjalne źródła mówią, że custom token wygasa maksymalnie po godzinie i że po `signInWithCustomToken()` użytkownik pozostaje zalogowany, dopóki sesja nie zostanie unieważniona lub użytkownik się nie wyloguje ([Create Custom Tokens](https://firebase.google.com/docs/auth/admin/create-custom-tokens), [Manage User Sessions](https://firebase.google.com/docs/auth/admin/manage-sessions)). Nie opisują wpływu refresh-token revoke na niewymieniony custom token, więc kontrakt nie może tego zakładać. Drugi briefing: architektura 0,65; prostota 0,65; ryzyko 0,65; utrzymywalność 0,70; minimum **0,65** — odrzucono. Walidator wskazał niemożność atomowego spięcia Firestore commit z HTTP response, nieprecyzyjne lock/lease/expiry i key rotation oraz brak dokładnego account binding ACK.

Wyniki są zgodne z kryterium planu: minimum <0,8 wymaga redesignu, a nie wdrażania spekulatywnej polityki sekretu. Ocena samej dokumentacji blockeru: zgodność/architektura **0,95** (odkładająca implementację, która przekracza repozytorium backendu), prostota **0,96** (jedna aktualizacja raportu i root planu), ryzyko **0,98** (bez zmian auth, sekretów, emulatorów i danych), utrzymywalność **0,92** (evidence i jawny gate zostają przy kanonicznym AUD-08). Minimum **0,92**. Nie zmieniono runtime API, store, klienta, kluczy, konfiguracji, emulatorów ani danych.

**Wymagana decyzja kontraktowa przed kolejnym briefingiem:** kiedy recovery uznaje się za zakończone (token minted, HTTP response received czy `signInWithCustomToken` potwierdzone), jak aplikacja trwale potwierdza tę samą operację po restartach, jak długo i jak chronić odzyskiwalny custom token, oraz czy reissue/deletion czekają na ACK lub wygaśnięcie. Implementacja wymaga skoordynowanego backend/mobile protocolu; lokalne backend-only work nie spełni AC.

Nie zmieniono produkcyjnego store, endpointu ani klienta. Nie uruchamiano API; Auth i Firestore emulatorów nie czyszczono ani nie restartowano. Niezależny QA dokumentacji: `PASS WITH ISSUES`; poprawiono minimum pierwszego briefingu z 0,66 na 0,48 oraz doprecyzowano sformułowanie właściwości Firebase.
