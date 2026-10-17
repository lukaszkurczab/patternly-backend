# Sandbox i APK Android — próba 17.10.2026

Status: **PARTIAL**. Commit/push i APK zakończone. Nowy backend działa jako kandydat bez ruchu, lecz nie został
promowany: readiness 503 i pełne CI FAIL. Po odmowie instalacji właściciel
wybrał pozostawienie APK do ręcznej instalacji; testy fizyczne NOT RUN.
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
**Decyzja właściciela 17.10.2026: „Wdróż testowo bez zmiany TTL — wyjątek
od runbooka”.** TTL pozostaje 34/35; nie ponawiać mutacji ani pytania.
Wyjątek dotyczy TTL; nie usuwa pozostałych technicznych FAIL.

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
  zabezpieczeń telefonu. **Właściciel wybrał: „Pozostaw APK do ręcznej instalacji”.**
  Nie ponawiać instalacji ani automatycznych testów telefonu bez nowego polecenia.
- Uruchomienie, rejestracja/logowanie, onboarding, nauka/wynik, restart/postęp,
  ustawienia i wylogowanie: **NOT RUN**. Nie utworzono użytkowników testowych;
  brak kont lub danych testowych do sprzątania. Innych aplikacji/danych nie zmieniano.

## Wznowienie po decyzjach właściciela — 17.10.2026

Uzupełniono tylko udokumentowane `REVENUECAT_PROJECT_ID=proj8ae78267` i ponownie
użyto dokładnie tego samego obrazu, bez nowego buildu. Nowa rewizja
`patternly-backend-sandbox-qa2-1017-66e960a` **startuje, 0% ruchu**.
[Endpoint kandydata](https://qa-1017---patternly-backend-sandbox-ix2onccfaq-lm.a.run.app/health).
Readback potwierdził tę samą tożsamość runtime, obraz i wszystkie referencje
sekretów; jedyna zmieniona zmienna to identyfikator projektu RevenueCat.
Warunki Cloud Run są True, co potwierdza start kontenera, a nie gotowość aplikacji.

| Sprawdzenie kandydata | Rzeczywisty wynik |
| --- | --- |
| `/health` | 200 |
| `/openapi.json` | 200, 81 operacji |
| `/v1/entitlements` bez App Check | 401, `app_check_required` |
| `/ready` | **503**, database/authentication/providerReader=true, contentPackages=false |
| Główny sandbox | Poprzednia rewizja `domain-mail39-1016`, 100% ruchu; `/ready` nadal 200 |

Nie promowano kandydata. Nie obniżano kontraktu readiness ani nie włączano
dormant stores. Nie powtarzano pełnego CI; jego wynik nadal **413 PASS / 2 FAIL /
12 SKIP**, opisany powyżej. Wcześniejsza nieudana rewizja pozostaje historycznym
dowodem pierwszej próby, nie aktualnym wynikiem startu.

Dowody prywatne: `/private/tmp/patternly-sandbox-service-resume-staged.json`,
`/private/tmp/patternly-sandbox-stage-resume-probes.json`. Surowy snapshot usługi
może zawierać prywatną konfigurację; nie należy go dodawać do Gita.

### Konkretna propozycja dalszych usług — niezastosowana

Bieżący [plan](../../docs/PATTERNLY-WORKING-PLAN.md) / PREMIUM-SERVICES i
[przekazanie20](../../patternly/docs/reports/premium-rc20-2026-10-15.md)
odkładają infrastrukturę pakietów po testach wewnętrznych. Wyjątek TTL nie
rozstrzyga tej kolejności. W czacie oczekuje decyzja: rozpocząć te usługi teraz
w sandbox czy zachować dotychczasowy sandbox do testów ręcznych.

Przy decyzji „teraz” zakres do zaprojektowania i odebrania obejmuje:

- Proponowany prywatny bucket `patternly-app-sandbox-content`, projekt
  `patternly-app-sandbox`, region `europe-central2`, uniform bucket access
  i public access prevention. Nazwa jest propozycją, nie utworzonym zasobem.
- Wyłącznie istniejący przyjęty pakiet AWS / `identity_federation_and_root_access`,
  gzip **71517 B**, SHA256
  `10935a7d50a4ef4f3fda59f53c0c9ce98b1e5207bc093a1424179a817b07aa1a`.
  Aktualny validator backendu potwierdził manifest i bajty lokalne; immutable
  upload z warunkiem generation=0 i readback, bez ponownego admission.
- Manifest `contentNodePackages/be66728010dce709607ffb1b4153b0127af2268d03bed38cf2a54e96cf3af730`
  i pointer `contentNodePackagePointers/aws-certified-solutions-architect-associate:identity_federation_and_root_access`.
  Dokładne read-only GET obu dokumentów zwróciły **404**; niczego nie zapisano.
  Przed zapisem ponownie sprawdzić stan i uniknąć nadpisania cudzej aktywacji.
- Odbiór rzeczywistego odczytu obiektu i podpisu V4 ≤60 s oraz trzy
  `CONTENT_PACKAGE_*` vars. Nie dodawać ról szerszych niż potrzebne.
  **Istniejący** runtime SA ma już projektowe `roles/editor` i self
  `roles/iam.serviceAccountTokenCreator`; nie nadano ich w tym zadaniu.
  Nie twierdzimy, że obecna tożsamość nie ma write/list. Dobór najmniejszych
  uprawnień wymaga uwzględnienia tej zastanej konfiguracji; rekomendowany
  dalszy projekt to osobna tożsamość runtime z odczytem obiektu i samym
  podpisywaniem oraz wymaganym dostępem aplikacji, bez odbierania ról
  dotychczasowemu SA używanemu przez stary sandbox. Taki projekt wymaga
  osobnego sprawdzenia przed zastosowaniem. Rola
  `roles/storage.legacyObjectReader` ma tylko `storage.objects.get`,
  ale dodatkowy grant nie ogranicza istniejącego Editor.

Mały probe Firebase Admin odrzucił custom credential przed odczytem
(`firestore/invalid-credential`); skorzystano z oficjalnego REST API przez
uwierzytelniony curl, bez wyłączenia TLS, nowych ADC ani wypisywania tokenu.
Dowód dokumentów: `/private/tmp/patternly-sandbox-package-proposal-readback.json`.

Plan ograniczonego stagingu: dopasowanie/prostota/ryzyko/utrzymywalność
0,95/0,95/0,90/0,95; minimum0,90. Niezależny design review Luna High0,90
zaakceptował ograniczony krok i wskazał konieczną decyzję przed uruchomieniem
wcześniej odłożonych usług. Propozycja infrastruktury bez tej decyzji miała0,72
i nie została wdrożona. Po odczycie istniejącego Editor reviewer ocenił
nieuzgodnione uruchomienie pakietu na obecnym SA na0,68; nie stosować tego
wariantu. Końcowy niezależny odbiór ograniczonego stagingu: PASS w swoim
zakresie, ocena0,94. To nie PASS gotowości/promocji. Nie zamieniano
historycznych FAIL w PASS.

## Kontynuacja

Zachować wysłane commity i gotowy APK. TTL ma zatwierdzony wyjątek, instalację
pozostawiono właścicielowi; nie ponawiać dawnych pytań ani tych działań.
Po decyzji dotyczącej usług rozstrzygnąć readiness i dwa FAIL CI przed promocją.
Nie utworzono kont testowych, nie ma danych tego zadania do sprzątania.
Automatyzacja pozostaje aktywna z aktualnym checkpointem i milczy bez istotnej
zmiany lub nowej odpowiedzi. Fizycznych testów nie przedstawiać jako wykonanych.
