# Lokalny panel administratora

Wymagania: zależności zainstalowane przez `npm ci` w backendzie i webie,
Node.js 22.12+, Firebase CLI oraz Java 21+. Launcher na macOS wybiera istniejący
JDK 21+, jeśli domyślny jest starszy; niczego nie instaluje.

Z katalogu `patternly-backend`:

```sh
npm run dev:admin
```

Panel: http://127.0.0.1:25173/admin. API: http://127.0.0.1:28080.
Login i losowe hasło znajdują się w `.local/admin/credentials.json` (uprawnienia
600). To konto istnieje wyłącznie w lokalnym Auth Emulatorze; nie potrzebuje
konta Firebase w chmurze. Przy pierwszym starcie kolejka jest pusta. Launcher
nie dodaje zgłoszeń ani treści.

Launcher montuje logicznie lokalne `../patternly-content/artifacts` jako
wyłącznie do odczytu źródło panelu i wybiera niezmienny release
`patternly-launch-2026-08-25-01`. Dzięki temu katalog pytań pochodzi z
opublikowanego release, a nie z danych emulatora Firestore. Produkcja wymaga
odpowiednika tego montowania oraz `ADMIN_CONTENT_ROOT` i
`ADMIN_CONTENT_RELEASE_ID`; szczegóły opisuje `cloud-run-manual-deploy.md`.

Projekt `demo-patternly-admin` korzysta z prawdziwych emulatorów Auth (29199)
i Firestore (28181). Hub, logowanie emulatorów i WebSocket używają odpowiednio
24410, 24510 i 9152. Wszystkie usługi słuchają na loopback. Zajęcie dowolnego
portu przerywa start bez zatrzymywania istniejących procesów.

Ctrl+C zatrzymuje web/API, a następnie eksportuje emulatory do
`.local/admin/data`. Kolejny start importuje te dane. Katalog `.local` jest
ignorowany przez Git. Nie zamykaj procesu siłowo, jeśli chcesz zachować ostatnie
zmiany. Uszkodzony plik credentials powoduje jawny błąd, nie reset konta.

Zmiana środowiska Firebase wymaga przeładowania strony. Konfiguracja lokalna
jest przekazywana przez launcher; nie wpisuj jej do produkcyjnego `.env`.
Testy usuwające dane lub tworzące testowe zgłoszenia uruchamiaj na osobnych
emulatorach z `firebase.admin-e2e.json`, nigdy w tym trwałym środowisku:

```sh
firebase emulators:exec --config firebase.admin-e2e.json \
  --project patternly-app-sandbox --only auth,firestore "npm test"
```

Na obecnym komputerze aktualny Node 22 jest zainstalowany przez Homebrew.
Jeżeli powłoka wybiera starszy Node 22.9 z nvm, użyj:

```sh
PATH="/opt/homebrew/opt/node@22/bin:$PATH" npm run dev:admin
```
