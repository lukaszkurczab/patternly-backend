# Purchase receipt delivery — prompt 06 / M10

14.10.2026. Odbiór dotyczy lokalnego kodu osiągalnego przez `POST /v1/webhooks/revenuecat`. Nie jest odbiorem usług ani wydania. Historyczny raport solo M10 jest niedostępny; defekt potwierdzono w źródłach: wspólny catch obejmował SMTP i finalizację, a retry przejmował wygasłe `sending`.

## Trwały kontrakt

Store zapisuje atomowo event, receipt oraz `users/{userId}/purchaseReceipts/{receiptId}/deliveryAttempts/{deliveryClaimId}` przed zwróceniem pracy do sendera. Próba ma pełny snapshot `PurchaseReceiptDelivery` (odbiorca, transaction/confirmation/product, cena, locale, terms, żądanie natychmiastowego rozpoczęcia, receipt/claim identity), status `pending` i czas utworzenia. Zawartość maila jest deterministycznie budowana z tego payloadu. `receiptId` jest hashem transaction ID; `deliveryClaimId` identyfikuje jedną próbę. Message-ID pozostaje stabilny dla receipt; nie zapewnia deduplikacji SMTP.

| Stan / dowód | Zachowanie |
| --- | --- |
| Nowa próba lub potwierdzone `failed` | Transakcja tworzy nowy trwały rekord próby przed SMTP. Historia poprzednich prób pozostaje. |
| `sending` z aktywną lease | Duplicate nie dostaje payloadu do wysłania; HTTP 503 `purchase_receipt_delivery_pending`. |
| `sending` po wygaśnięciu lease | Transakcja uzgadnia receipt i istniejącą próbę do `unknown`, zachowuje identity/payload; HTTP 503 `purchase_receipt_reconciliation_required`. Nie tworzy nowej próby. |
| `unknown` / nierozpoznany stan | Brak automatycznego resend; HTTP 503 wymagający reconciliation. |
| Sender potwierdził accepted | Osobna finalizacja do `sent`. Jej błąd nigdy nie staje się `failed`. |
| Accepted + błąd finalizacji | Best effort zapis `unknown`; HTTP 503. Jeśli ten zapis też zawiedzie, wcześniejszy `pending` nadal blokuje resend. **Nie twierdzimy, że nieudany zapis utrwalił unknown.** |
| Commit `sent` wykonany, odpowiedź utracona | Best effort unknown nie zmienia terminalnego sent; retry zwraca 200 bez wysyłki. |
| Potwierdzone odrzucenie / brak sendera | `failed` dopuszcza nową próbę przy webhook retry. |
| Wygasły/zastąpiony claim albo nieaktywne konto podczas finalizacji | Finalizacja zwraca false; bieżący handler nie zwraca sukcesu. |

Finalizacja wymaga aktywnego konta, zgodności claim ID, niewygasłej lease oraz istniejącej próby `pending`; aktualizuje receipt i próbę w jednej transakcji. Claim ID pozostaje po finalizacji. Stary claimant nie zmienia nowej próby. Wygasła lease nie stanowi dowodu odrzucenia maila.

Typowany `PurchaseReceiptEmailRejectedError` pochodzi wyłącznie z jawnego rejected recipient albo odpowiedzi SMTP 4xx/5xx przy MAIL FROM, RCPT TO lub DATA. Disconnect, timeout, brak rozpoznanego wyniku oraz inne wyjątki oznaczają niepewność. Testy używają zainstalowanego Nodemailer, także przez rzeczywiste lokalne gniazdo SMTP. Nie przekazujemy treści błędu providera do odpowiedzi.

Nie ma SMTP przed potwierdzonym commitem początkowej transakcji. Definitywny brak commitu nie może pozostawić trwałego rekordu. Utrata odpowiedzi **po** commicie pozostawia próbę pending; stabilny event pozwala ją odczytać, a wygasły claim przechodzi w unknown bez wysyłki. Lokalny fault modeluje te granice przez wstrzyknięcie błędów wokół realnych operacji store; nie symuluje awarii infrastruktury Firestore.

## Zakres plików i usunięte zachowanie

- `src/modules/billing/revenuecatWebhookStore.ts`: trwałe próby, retry tylko failed, reconciliation wygasłego sending, finalizacja chroniona claimem/lease/aktywnym kontem.
- `src/api/app.ts`: wyłącznie import błędu purchase i handler webhooka. Istniejący hunk sync 409 z promptu 05 zachowany.
- `src/infrastructure/email/smtpPrivacyEmailSender.ts`: typowane odrzucenie i ostrożna klasyfikacja tylko w purchase senderze; legal/privacy/security bez zmian.
- `tests/purchaseReceiptDelivery.emulator.test.ts`, `tests/purchaseReceiptSmtp.test.ts`: fault, replay, claim/concurrency i granica Nodemailer/SMTP.
- `tests/support.ts`: opcjonalny sender purchase/null; aplikacje pomocnicze współdzielą klienta Admin SDK, zamykanego raz na końcu testów.
- `tests/revenuecatWebhook.emulator.test.ts`: duplikat aktywnej próby ma jawny pending.
- `scripts/run-purchase-receipt-tests.mjs`: odtwarzalny wąski gate korzystający z istniejącego izolowanego runnera i projektu `demo-patternly-receipts`.
- Ten kontrakt, kanoniczny `../docs/PATTERNLY-WORKING-PLAN.md` i jedyny bieżący stan `../patternly/.agent/WORKING_STATE.md`.

Usunięto automatyczne przejęcie wygasłej wysyłki i wspólny catch zamieniający błąd finalizacji w retryable failure. Nie usuwano plików ani innych ścieżek. Sprawdzono referencje producentów/konsumentów receiptów; brak drugiej produkcyjnej ścieżki wysyłki. Firestore rules pozostają deny-all dla klientów. Nowa podkolekcja pozostaje pod user subtree, które istniejące usuwanie konta odwiedza rekurencyjnie; bez nowej polityki TTL, migracji, indeksów lub zmian eksportu.

## Weryfikacja i review

Runtime: Node **22.22.3**, Java **Temurin 23.0.1**, zainstalowane zależności backendu; bez ich zmiany. Komendy z katalogu `patternly-backend`, z właściwym Node/Java w środowisku:

```sh
node scripts/run-purchase-receipt-tests.mjs
npm run typecheck
npm run lint
npm run openapi:check
git diff --check
```

Main: wąski gate **34/34 PASS, 0 SKIP** (12 fault/store/route, 9 istniejących RevenueCat emulator, 3 reducer/auth/schema, 6 SMTP granica/klasyfikacja, 4 istniejące sender/config). Typecheck, lint, OpenAPI/runtime **76 operations**, diff check PASS. Faulty obejmują zapis przed/po finalnym commicie, brak commitu unknown, brak/utratę odpowiedzi początkowego commitu, retry, expiry, stary claim, pięć współbieżnych webhooków oraz jednoczesne początkowe/ponowne claimy. Sender czyta realny committed attempt i porównuje cały payload przed efektem. Lokalne SMTP: DATA250, RCPT550, DATA550, disconnect po całym DATA.

Pierwsze nieudane próby: nazwa demo projektu przekraczała istniejący limit 30 znaków (skrócona bez zmiany walidatora); następnie pomocniczy context kończył współdzielonego klienta Firestore (zamknięcie klienta przeniesione na koniec pliku). Wcześniejsze wywołanie typecheck z katalogu workspace nie znalazło package.json; właściwy backend typecheck przeszedł. Nie zmieniano produkcyjnego kodu dla obejścia tych błędów harnessu.

Niezależny design review: **gpt-6-luna high**, podejście przyjęte z jawną granicą ręcznej obsługi unknown. Main jest jedynym writerem. Ocena main: dopasowanie 0,96 / prostota 0,90 / kontrola ryzyka 0,88 / utrzymywalność 0,92; minimum 0,88. Niezależna ocena projektu: minimum 0,82. QA niezależnie wykonał końcowy gate **34/34, 0 SKIP** oraz samodzielnie testy SMTP **6/6**, sprawdził źródła, hashe i residual w planie. Końcowy verdict **PASS WITH ISSUES**: wszystkie AC wycinka 06 spełnione, bez blokera; jawne ograniczenie operacyjne to brak resolvera operatora dla unknown (poza zakresem sesji).

## Granice i residual

Reconciliation w tym wycinku to **wykrycie wygasłej/niepewnej próby, trwałe unknown i zakaz automatycznego resend**, a nie potwierdzenie dostarczenia. Nie dodano endpointu/CLI do ręcznego rozstrzygnięcia unknown. Takie próby mogą pozostać nierozstrzygnięte; przed operacyjną obsługą trzeba uzgodnić wynik z dostawcą i autoryzowaną procedurę. Sama lease, webhook retry ani stabilny Message-ID nie uprawniają do wymuszenia failed/resend. To ograniczenie pozostaje w istniejącym SOLO-MAIL-01/ODK-E2E-086; nie jest obietnicą exactly-once.

Legal/privacy mail routes pozostają wyłączone. Ich analogiczne pułapki finalizacji i niepewności wymagają odrębnej naprawy **przed uruchomieniem**, zgodnie z residualem planu. Nie odebrano zewnętrznego SMTP/TLS/auth, RevenueCat/sklepu, dostarczenia do skrzynki, fizycznego urządzenia, hosted CI, pełnej suity ani wydania. Nie wykonano maili, zmian usług, publikacji, reset/reinstall/newGuest, commit/push lub nowej automatyzacji/wątku. Następny dopuszczalny prompt: **07**, bez uruchamiania go.

## Identyfikacja sprawdzonych źródeł

BACKEND bazowy HEAD `1fea72c9f64d82f8bcd534d3624664629eaf7d51` + zachowany pakiet WIP 05 + lokalna delta 06. Hashe SHA-256 po końcowym gate (app.ts obejmuje również zachowany hunk 05):

| Plik | SHA-256 |
| --- | --- |
| `src/api/app.ts` | `38da3fd06247416c6865078d3798aae53a6a08d4a43bd63e4a7a45939ddaf5fe` |
| `src/modules/billing/revenuecatWebhookStore.ts` | `d29541a51540a3851b37423159ea74486979ce694ca966bcadb47e5856350cdb` |
| `src/infrastructure/email/smtpPrivacyEmailSender.ts` | `81d6fef06480fa8168657e936a69ca968ca44d6bad4ea8c0c1a8957a8a40848b` |
| `tests/purchaseReceiptDelivery.emulator.test.ts` | `466c52388b888f6d87d33795cceac13a6967d96ff564b89deacd36511e571f44` |
| `tests/purchaseReceiptSmtp.test.ts` | `9a782fdfb33556f9a6d55c64b2236c9c0eeccc7237b8d626792c5ef7f5c1c918` |
| `tests/support.ts` | `4876caddb4a776524c3c5467419772df8f928ae44d0c381ee56db3be52346b42` |
| `tests/revenuecatWebhook.emulator.test.ts` | `0631572728ae409b69f24a5d1e6048506a6e94152063b699739841d177f75897` |
| `scripts/run-purchase-receipt-tests.mjs` | `578c846c5c37813b9b3d59d6bb6da05f300a5c0400480f2301774588167dd437` |
