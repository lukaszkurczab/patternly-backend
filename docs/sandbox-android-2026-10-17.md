# Sandbox i APK Android — próba 17.10.2026

Status: **PARTIAL**. Commit/push i APK zakończone. Nowy backend nie został
promowany; testy fizyczne nie rozpoczęły się z powodu odmowy instalacji telefonu.
Jedyny bieżący stan i następny krok: workspace `.agent/WORKING_STATE.md`.

## Źródła i publikacja kodu

- APP `4090c974b786a4fdd9660217626d20f003aff882`, origin/main — push zakończony.
  Zawiera odebrane poprawki bramek APP i trzy skorygowane residualne asercje.
- CONTENT `7fc7bf87579f408b02eda4a6b7acabca0a200ca8`, origin/master — push zakończony.
  Brak zmiany pinów, admission i artefaktów w tym zadaniu.
- BACKEND `66e960a505afc82ff46cd4b80ac96db82cb66292` oraz
  `57aa97a7bbb88598ac4200a08d0dd29bd6b823e5`, origin/main — push zakończony.
  Korekty tylko fixture, diagnostyki TTY i konfiguracji emulatorów.
- WEB bez lokalnych zmian, HEAD `0171a77`; nie publikowano witryny ani dokumentów prawnych.

Nie usuwano runtime paths. Nie zmieniano kodu produktu ani zależności.

## Faktyczna weryfikacja

- APP `qa:static`: **2900 PASS / 0 FAIL / 5 SKIP**, exit 0; recovery, typecheck
  i obie kontrole granic PASS. SKIP: cztery opt-in emulatorowe i opcjonalny CC04.
  Log: `/private/tmp/patternly-sandbox-qa-static.log`.
- Backend `ci:cloud`: PASS; 11 testów, lint, typecheck, TTL config 35,
  OpenAPI 81 operacji i build. To nie zastępuje pełnego CI.
- Dwie poprawione fixture backendu: **27/27 PASS**.
- Izolowany cały `progressStorage.emulator.test.ts`: **12/12 PASS**.
- TTY: trzy ograniczone przebiegi całego pliku po 5/5 PASS; nie odtworzyły awarii.
- Recovery emulator: **21/21 PASS**.
- Paging rzeczywistego backendu i mobilnego adaptera/restore: **PASS**, 212 rekordów,
  105 sesji, 105 prób, 1 review, dwa pełne odczyty, 6 żądań stron.
  To MemoryStorage i emulator, nie dowód fizycznego telefonu.
- Operator emulator **4/4 PASS**, operator acceptance **1/1 PASS**,
  OpenAPI 81, inventory klienta 57 i build PASS.
- Końcowy pełny `npm run ci`: **413 PASS / 2 FAIL / 12 SKIP**, exit 1.
  FAIL: concurrent accepted-pair transaction — emulator
  `INVALID_ARGUMENT: Transaction is invalid or closed`; native TTY cancellation FD3 —
  `PermissionError/1` mostka. Diagnoza nie wykazała deterministycznego błędu
  użycia transakcji w aplikacji; nie dowodzi też poprawności produkcyjnej konkurencji.
  Nie osłabiano testu, nie dodawano retry do runtime i nie ogłoszono pełnego PASS.
  Log: `/private/tmp/patternly-sandbox-backend-ci-verified.log`.

Początkowe FAIL smoke entitlement i token +31 sekund poprawiono według aktualnego
kontraktu; stale paging fixture dostosowano do odebranego wzorca APP account reset.
`singleProjectMode:false` odpowiada wielu celowym projektom demo w suicie; nie
udowodniono, że wyjaśnia dokładny błąd transakcji. Bezpieczna diagnostyka TTY
ujawnia tylko klasę wyjątku i errno, bez treści mogącej zawierać token.

## Obraz i sandbox

Cloud Build **SUCCESS**:
`98ba452b-1855-492c-9cdd-da95c44b6feb`, region `europe-central2`,
source BACKEND `66e960a`, image:
`europe-central2-docker.pkg.dev/patternly-app-sandbox/patternly/patternly-backend@sha256:85d853a30c7cb585179ba2f6c8ab1baf8eb6d24a26a7aec4a20412b76fc5c59c`.
`src/`, package/lock, Dockerfile i cloudbuild.yaml są identyczne między tym commitem
obrazu a `57aa97a`; późniejsze zmiany dotyczą wyłącznie testowania.
Pierwszy submit miał błąd walidacji zbędnego COMMIT_SHA i nie utworzył builda;
drugi podał dokładny SHA w istniejącym `_IMAGE`.

Próba staging bez ruchu, z zachowaniem env/secrets/SA:
`patternly-backend-sandbox-qa-1017-66e960a` — **FAIL startup**, exit 1,
log `bootstrap_failed/internal_error`. Bezpieczny preflight kształtu konfiguracji
potwierdził `production_revenuecat_config_required`: obecna konfiguracja nie ma
wymaganego `REVENUECAT_PROJECT_ID`. Nie pobierano ani nie wypisywano wartości sekretów.
Po usunięciu tego braku aktualny source `/ready` wymaga również nieobecnej
konfiguracji content packages; tego wyniku nie wywołano na nowej rewizji,
ponieważ nie wystartowała. Nie włączano dormant stores dla zielonego readiness.

Readback potwierdził niezmienione mapowanie ruchu: 100% na
`patternly-backend-sandbox-domain-mail39-1016`; wcześniejsze tagi Android/iOS
zachowane, nowy tag QA nie został opublikowany. Dotychczasowy główny endpoint
po próbie nadal zwracał `/health=200` i `/ready=200`. Stan usługi pokazuje
nieudaną najnowszą konfigurację; nie oznacza to odbioru nowego obrazu.

Firestore Native/Standard, PITR 7 dni — potwierdzone. TTL **34/35 ACTIVE**;
brak `sessionRevocationOperations/expiresAt`. Pełny read-only group scan znalazł
8 rekordów, żaden nie miał expiresAt, zero wygasłych. Niezależny review Luna High
zaakceptował warunkowy plan minimalnego TTL (ocena 0,82), lecz **automatyczna kontrola
uprawnień odrzuciła mutację** z powodu przyszłego usuwania rekordów innych
użytkowników sandbox. Nie zastosowano polityki, nie obchodzono odmowy.
W czacie oczekuje decyzja właściciela: testowy wyjątek od runbooka bez TTL albo
zgoda na TTL całej kolekcji. Ta decyzja nie usuwa pozostałych technicznych FAIL.

## APK i telefon

[EAS build](https://expo.dev/accounts/lkurczab/projects/patternly/builds/42af94a6-09a1-40bc-8458-e5a661f1eced)
— **FINISHED**, APP `4090c974`, profil `sandbox`, EAS environment `preview`.

[APK](https://expo.dev/artifacts/eas/KIbFHx_dzLcBrP0ZANjwV_WjXp9HsPYAAA4aoeDkQ24.apk)

- SHA256 `5a3c9f6c1a3a5c670448f6c4e7d68e2cfe336c54f01b7f27a74ab62789530c61`.
- Lokalnie `/private/tmp/patternly-sandbox-android-20261017/patternly-sandbox.apk`.
- W rzeczywistym bundle potwierdzono `patternly-app-sandbox` i główny API origin
  `https://patternly-backend-sandbox-958691314582.europe-central2.run.app`.
- Fizyczny Redmi Note11, model 2201117TY, Android13, ADB9d112858 — autoryzowany dostęp.
- Pierwsza instalacja: **FAIL** `INSTALL_FAILED_USER_RESTRICTED: Install canceled by user`.
  APK nie jest zainstalowany. Nie ponawiano bez zmiany warunków ani nie zmieniano
  zabezpieczeń telefonu. W czacie oczekuje pytanie o zgodę w telefonie/ręczną instalację.
- Uruchomienie, rejestracja/logowanie, onboarding, nauka/wynik, restart/postęp,
  ustawienia i wylogowanie: **NOT RUN**. Nie utworzono użytkowników testowych;
  brak kont lub danych testowych do sprzątania. Innych aplikacji/danych nie zmieniano.

## Kontynuacja

Nie ponawiać istniejących buildów, push, odrzuconego TTL ani instalacji w tych
samych warunkach. Po decyzjach właściciela rozstrzygnąć CI/config/readiness,
przygotować sprawdzoną nową rewizję i dopiero promować; następnie instalacja
z pozwoleniem telefonu, realne testy i cleanup tylko własnych kont.
Automatyzacja pozostaje aktywna z checkpointem i ma milczeć bez istotnej zmiany.
