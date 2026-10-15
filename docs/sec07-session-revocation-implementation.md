# SEC-07 / prompt 13 — implementacja i lokalny odbiór

14.10.2026. **Status: PASS kodu i lokalnego emulatora; niezależny QA `gpt-6-luna high` PASS.** Zakres wyłącznie prompt 13;
projekt prompt 12 był odebrany i nie jest ponownie wdrażany jako nowe zadanie.
[Odebrany kontrakt](sec07-session-revocation-replay-design.md),
[jedyny plan](../../docs/PATTERNLY-WORKING-PLAN.md),
[bieżący stan](../../.agent/WORKING_STATE.md).

## Wynik i własność

Istniejący `FirestoreAccountLifecycleStore.revokeSessions` pozostaje jedynym
writerem. Terminalny `revoked` ma jednokrotne `terminalAt` i dokładne
`expiresAt = terminalAt + 30 × 24 h`. Retry mint nie zmienia także `updatedAt`;
nie ponawia potwierdzonego revoke. Odczyt odmawia przy `expiresAt <= now`, przed
mint i ponownie po nim, jeśli konto/generacja/termin zmieniły się podczas pracy
providera. Nie zwraca wtedy tokenu. `pending` i `failed` pozostają bez TTL,
korzystając z dotychczasowego lease/fence.

Brak dokumentu pozwala tylko na UUIDv7 w domkniętym przedziale
`[now - 29 × 24 h, now + 5 min]`; bramka działa w tej samej transakcji co slot,
przed zapytaniem o identity i providerem. Stare v7 i brakujące v4 odmawiają
bez zapisu nowej operacji, revoke albo grantu. Nieznany/uszkodzony stan również
odmawia. Istniejące v4 pozostają ponawialne. Zweryfikowany legacy `revoked` jest
migrowany leniwie w transakcji z dawnego `updatedAt`, również po expiry;
nie zaczyna nowego okresu od dnia migracji.

Klient generuje v7 w obu rzeczywistych wejściach wylogowania: scoped repository
i fallback providera. Jeden mały generator jest współdzielony przez te wejścia.
Parsery kolejki i scoped sign-out czytają v4/v7 bez przepisywania ID. Generator
recovery/deletion pozostaje v4 (pozostały helper nazwano zgodnie z recovery).
Wyłącznie typowany błąd `session_revocation_operation_expired` z konkretnego
revoke daje jawny ekran z przyciskiem ponownego unieważnienia sesji, w 7 locale.
Retry nie podmienia ID. Świadoma akcja zastępuje wyłącznie wskazaną parę UID/ID,
bez fałszywego ACK starego żądania i bez zmian innych pending/completed/danych.
Po potwierdzeniu zapisu klient wykonuje dotychczasowy bootstrap/drain.

Niezależny QA odtworzył zapis-then-throw: pierwotna wersja CAS zostawiała ekran
ze starym ID mimo utrwalenia nowego. Poprawka potwierdza dokładny nowy snapshot
ponownym odczytem. Jeśli odczyt pozostaje niemożliwy, provider uruchamia istniejący
restore owner, który najpierw odczytuje trwałą kolejkę; nie generuje kolejnego ID.
Storage ma wtedy bezpiecznie starą albo nową parę, a sukces nie jest udawany.

TTL config, jego checker i deployment fixture obejmują 35 polityk, w tym
`sessionRevocationOperations/expiresAt`; runbook rozdziela expiry, eventual TTL
i kopie PITR. Zastąpiono bezwarunkową gałąź `revoked` oraz v4-only ścieżki revoke.
Nie usuwano plików ani używanego generatora v4 recovery/deletion. Paths i schemat
UUID Zod już obsługiwały potrzebny kontrakt, więc nie dodano ich kopii.

Ocena podejścia (0–1): dopasowanie 0,95 / prostota 0,91 / kontrola ryzyka 0,86 /
utrzymywalność 0,92; minimum 0,86. Niezależny design review `gpt-6-luna high`:
PASS, minimum 0,82. Main jedynym writerem; reviewer read-only.

## Fakty, inventory i granice legacy

Odczyt aktualnego writera, wszystkich referencji kolekcji w `src`/`scripts` oraz
historycznego writera `856b546` potwierdził, że terminalny `updatedAt` zapisywano
przy finalizacji i nie odświeżano przy retry mint. Przed testami żaden lokalny
Auth/Firestore emulator nie nasłuchiwał na 19099/18081/19119/18119; nie było
aktywnego lokalnego zbioru starszych rekordów do inventory. Izolowane fixture’y
sprawdzają poprawne v4 i v7, zły czas/kształt/status, brakujące pola, zły UID lub
generację oraz niepełną terminalność. **Nie wykonano cloud inventory/backfill.**
Przed service rollout inventory rzeczywistych starszych kształtów pozostaje
warunkiem runbooku; nie jest domniemanym wynikiem lokalnych testów.

## Wykonana weryfikacja

Node 22.22.3, istniejące lockfiles/dependencies. Izolowany projekt
`demo-patternly-sec07`, Auth19119/Firestore18119; bez używania/zerowania danych
współdzielonego backendu. Użyto istniejącego izolowanego runnera, nie nowego
systemu diagnostycznego.

| Sprawdzenie | Wynik i zakres |
| --- | --- |
| Niezależny `npm run test:session-revocation:emulator` | **28/28 PASS**, w tym 7 nowych SEC-07: niezmienność timestampów po mint failure/retry, expiry −1/0/+1 ms, fizyczny delete, nowe świadome ID, 29d/+5m i ±1 ms, legacy v4, pending/failed 90d, malformed/bindings, expiry/deletion/generation podczas mint, rzeczywisty generator + adapter klienta → HTTP → store + lokalna kolejka |
| Regresje zawarte w powyższych 28 | 21/21 PASS: race/live slot/fence, provider failure/retry, token retry oraz account deletion i późniejsze odmowy writerów |
| `aud08Recovery.emulator.test.ts`, tylko `session revoke supersedes expired recovery result without cipher configuration` | 1/1 PASS; recovery owner i cleanup wyniku zachowane po zmianie nowych ID |
| APP focused identity/logout/pending/bootstrap/composition (main) | 93/93 PASS, 0 skip; obejmuje v4/v7 round-trip, exact-pair CAS, write failure/write-then-error/unconfirmed read, exact expired-ID eligibility i wiring dedykowanej akcji |
| Niezależny APP focused identity/logout/pending/composition/canonical repositories | **95/95 PASS**, 0 skip; dokładna komenda poniżej; nakłada się na testy main, liczników nie sumować |
| APP canonical repository, tylko nowy test `session revoke sign-out` | 1/1 PASS: prawdziwe scoped sign-out tworzy v7, czyta istniejący v4, deletion nadal v4 |
| BACKEND deployment + OpenAPI contracts | 29/29 PASS; deployment test używa fake gcloud, nie wywołuje chmury |
| BACKEND typecheck, lint, TTL check, OpenAPI check, frontend transport inventory, build, diff check | PASS; TTL35, OpenAPI76, 54 używane operacje klienta |
| APP typecheck i diff check | PASS |

Pierwsze próby wykryły błędy fixture’ów, a nie zmiany wymagające złagodzenia AC:
nieistniejący eksport konfiguratora App Check (poprawiono na rzeczywiste
`getAppCheckToken`/`fetchImplementation`), niedeterministyczne podmiany UUID
(poprawiono konkretne bity wersji/wariantu po małym probe), oraz dwa błędy typów
nowych testów. Powyższe PASS dotyczą poprawionych źródeł. Nie powtarzano całych
suit/CI ani wcześniejszych odbiorów tylko dla SHA. 21 regresji zachowuje ważność:
production backend, dependencies/config emulatora nie zmieniły się po tym PASS;
późniejsze poprawki dotyczyły fixture i klientowego error-recovery.

Odtwarzanie głównego odbioru (bez dostępu do chmury):

```sh
# BACKEND — istniejący izolowany runner, demo Auth/Firestore
npm run test:session-revocation:emulator
node --import tsx --test tests/deployment.test.ts tests/openapiContracts.test.ts
npm run typecheck
npm run lint
npm run firestore:ttl:check
npm run openapi:check
npm run frontend:client:check
npm run build
# APP — dokładny niezależny zestaw 95 testów
node --import tsx --test src/infrastructure/identity/sessionRevocationOperationId.test.ts src/infrastructure/storage/localLogoutControl.test.ts src/application/account/pendingSessionRevocation.test.ts src/application/account/accountIdentityComposition.test.ts src/storage/repositories/canonicalRepositories.test.ts
npm run typecheck
```

Testy backendu używają rzeczywistego Firestore/Auth emulatora, a efekty revoke/mint
są kontrolowanymi portami z licznikami. Dowód adaptera klienta obejmuje rzeczywistą
serializację/obsługę HTTP, lecz testowy transport do Fastify i storage pamięciowy.
Niezależny QA: **PASS** dla żądanych AC kod/emulator; poprawka niepewnego zapisu odebrana. Wiring UI sprawdzono źródłowo i przez zachowanie klasyfikatora; nie wykonano
renderu nowego ekranu, native SecureStore/MMKV ani smoke urządzenia. Nie jest to
odbiór usług Firebase, chmurowego TTL, natywnego klienta ani wydania.

## Pozostałe ryzyko i STOP

Zapas 23h55m zakłada poprawne zegary backendu/TTL; duży rollback nie jest
wykrywany. Jeśli Firebase revoke nastąpi, lecz finalizacja nie zostanie zapisana,
retry może powtórzyć zewnętrzny skutek (istniejąca granica niepewności).
Pre/post mint ogranicza race, ale nie stanowi atomowej transakcji z providerem ani
HTTP. Logiczne expiry nie obiecuje natychmiastowego wymazania PITR/log/backup.
Przedpremierowe założenie odebranego kontraktu: brak wspieranych starych buildów; backend i klient v7 są jednym pakietem; pojawienie się
wspieranego starego buildu wymaga odrębnego review rollout.

Cloud TTL pozostaje **ODK-E2E-082**, provider/device/release osobno.
Bez usług, maila, publikacji, reset/reinstall/newGuest, urządzeń, automatyzacji,
nowego czatu, commit/push. Zachowano wejściowy WIP SEC-04, app `.agent` i spec poza
SEC-07, wszystkie piny oraz kanoniczną relokację planu. Następny dopuszczalny
prompt: **14**, nieuruchomiony. Sesja kończy się po odbiorze tego pakietu.

## Zmienione pliki pakietu

**patternly-backend**

- `src/modules/account-lifecycle/store.ts`
- `src/api/app.ts`
- `src/api/openapi.ts`
- `openapi/patternly-v1.json`
- `config/firestore-ttl.json`
- `scripts/check-firestore-ttl.mjs`
- `scripts/run-session-revocation-emulator-tests.mjs`
- `package.json`
- `tests/support.ts`
- `tests/firestore.emulator.test.ts`
- `tests/sec07SessionRevocation.emulator.test.ts`
- `tests/aud08Recovery.emulator.test.ts`
- `tests/deployment.test.ts`
- `docs/retention-runbook.md`

**patternly**

- `src/infrastructure/identity/sessionRevocationOperationId.ts`
- `src/infrastructure/identity/sessionRevocationOperationId.test.ts`
- `src/infrastructure/storage/localLogoutControl.ts`
- `src/infrastructure/storage/localLogoutControl.test.ts`
- `src/storage/repositories/accountLifecycleRepository.ts`
- `src/storage/repositories/canonicalRepositories.test.ts`
- `src/application/account/pendingSessionRevocation.ts`
- `src/application/account/pendingSessionRevocation.test.ts`
- `src/application/account/AccountSessionProvider.tsx`
- `src/application/account/accountIdentityComposition.test.ts`
- `src/features/account/AccountEntryScreen.tsx`
- `src/locales/de/account.json`
- `src/locales/en/account.json`
- `src/locales/es/account.json`
- `src/locales/et/account.json`
- `src/locales/fr/account.json`
- `src/locales/it/account.json`
- `src/locales/pl/account.json`

**Dokumentacja workspace/app:** ten raport; `docs/PATTERNLY-WORKING-PLAN.md`; `.agent/WORKING_STATE.md` w workspace; wyłącznie §SEC-07 w app `docs/specs/engineering/security-privacy.md`.

## Tożsamość dowodu

BACKEND HEAD `65587f8a37ddcea3501dd1755dbea24bd8b4bf48`; APP HEAD `b449b7f2fad2b5031b6acff53e77c3530a962949`. Oba worktree zawierają WIP, więc poniższe skróty identyfikują badane bytes, nie sam HEAD. Piny niezmienione.

| Plik | SHA-256 |
| --- | --- |
| `patternly-backend/src/modules/account-lifecycle/store.ts` | `4fe13ae2f7cf12ee88af957f3dd807af8c85e1ca9b15efbc9b7a3f4d29f9e3aa` |
| `patternly-backend/src/api/app.ts` | `3daeb8a00ee3cc710751dc5f658218a8b752e0d608fc65e1b67ebc2d8dd3a22d` |
| `patternly-backend/src/api/openapi.ts` | `46a0fa4651110c989981d0f77f83ecaaf3ca9a8df10862684b960aaaed168c2e` |
| `patternly-backend/config/firestore-ttl.json` | `647cc72c51741e9c3a2c23bb8a87a1158e83a8aa628e2f137d7eed099b3ab0cd` |
| `patternly-backend/scripts/check-firestore-ttl.mjs` | `b37b26c1c88df501f77fcec4f58cdf1912d9afaa72f49fc121ac12a24551f085` |
| `patternly-backend/scripts/run-session-revocation-emulator-tests.mjs` | `8b11cd2914fe4d9ec12ea7a42d5e6fd3295bb9016b71b22b717ff93e224a07b9` |
| `patternly-backend/tests/support.ts` | `dfcb7fc93e1ff545b4ae33ec906b28ec11ab57ae2a503a6958e4b5db02cc804d` |
| `patternly-backend/tests/firestore.emulator.test.ts` | `f2a660765d79ef5f6a162ea9e6406e72d937cba94e04176421b4b53d9f866266` |
| `patternly-backend/tests/sec07SessionRevocation.emulator.test.ts` | `fb6d29d0b3b121db681753652b500100b756b5ef3477832babd8db67ee701c5d` |
| `patternly-backend/tests/aud08Recovery.emulator.test.ts` | `194b3bf22ee0af96cf868166720b492b5970211200bd60c16bbf4d96889e50f7` |
| `patternly-backend/tests/deployment.test.ts` | `bb3397d487ae14bb91965e83ca4a0f2c09a19953b76c1f783d06f7a26025c7ee` |
| `patternly/src/infrastructure/identity/sessionRevocationOperationId.ts` | `5c3c9fa0cea8673e8f1d1256f31bf92bc0641e975a2b1def330e9d7b4a306ece` |
| `patternly/src/infrastructure/identity/sessionRevocationOperationId.test.ts` | `54d339eec7bb0c27f6a4102ce916078e88f9cdbba3e5392b5e97220f849fa14c` |
| `patternly/src/infrastructure/storage/localLogoutControl.ts` | `da7e4ccdde31873be426c72c00feb5fc09e556351e4974f304553de9c1ed98f2` |
| `patternly/src/infrastructure/storage/localLogoutControl.test.ts` | `9f98e0c111e25e09ca97a26576ae59bf1a498f00c24edb0a2af7793508d245f2` |
| `patternly/src/storage/repositories/accountLifecycleRepository.ts` | `c890689d03614f88a96e9244ff20a08c0711eb65e47d6b2867053156a018ef54` |
| `patternly/src/storage/repositories/canonicalRepositories.test.ts` | `7aa3b3d9d7458516e1069f69c330564fd102b30136771c64ad32f9164820454e` |
| `patternly/src/application/account/pendingSessionRevocation.ts` | `76307c1c4d6e578975ec28f500cd6d551460b103d5be35b23ac0d11265815ad2` |
| `patternly/src/application/account/pendingSessionRevocation.test.ts` | `24dbbe0acd836f0fe6103b93196f7458e338746560ea17c5f8c59ed730f2f516` |
| `patternly/src/application/account/AccountSessionProvider.tsx` | `36a4f9eb629980468ce9b7f586895a939cda2e66f4b811ef48c5f3064fc86cd0` |
| `patternly/src/application/account/accountIdentityComposition.test.ts` | `e7313dfdbfd19837311b0abaf341d1badd221a0904c4ed5b7cdb28a0109bbd50` |
| `patternly/src/features/account/AccountEntryScreen.tsx` | `b7f2edd2059833d2bd4b27a2791300a66656014d6e0181fadcd131ff5dffa792` |
| `patternly/src/locales/de/account.json` | `17c9ba6c5a00ddc4948e4cd70e2794a9b79f32609db587e2f75025799efb67cc` |
| `patternly/src/locales/en/account.json` | `db5caa71ae25daf73721bae6e8318a65bc949d7bfb51ca4a7c9d74fff86aae31` |
| `patternly/src/locales/es/account.json` | `19a5e2c3ed844219f912d519099093c4572af04dce2110c589d0af06fa66d02d` |
| `patternly/src/locales/et/account.json` | `f8be77fe4f84beba7e667d8b39f3bdcfb3d5e1b8ca14b2b4a7c19f4b2979c7b2` |
| `patternly/src/locales/fr/account.json` | `f6332337c4a63891aa677b159ff245f0dc1770dd91536d24cea5063df17bfefc` |
| `patternly/src/locales/it/account.json` | `56b401a0001b210986efc8ba0a0967099cb0ddb8b791ed3fc1d7df696c798fb0` |
| `patternly/src/locales/pl/account.json` | `1ce0320f97eeb4d80a331a4c9e8783ff9c8910cfb50da952f6e2b5154d09e09d` |
