# GATE-02 — acceptance packet

## Cel

Zastąpić deklaratywną listę ścieżek pełnym, wykonywalnym kontraktem API dla wszystkich 54 aktywnych operacji backendu. Gate ma odrzucać rozjazd runtime–OpenAPI oraz rozjazd używanych operacji mobile/web z OpenAPI, zanim taki rozjazd trafi do wspólnego release gate. Task nie zmienia zachowania produktu, pytań, contentu ani zakresu późniejszych APPCHK/WEB.

## Ustalenia

- `src/api/app.ts` rejestruje 54 aktywne operacje, a `src/api/openapi.ts` wymienia 54 operacje, lecz bieżący `openapi:check` sprawdza tylko zgodność dwóch serializacji tego samego obiektu.
- Tylko 7/54 operacji ma schemat odpowiedzi sukcesu, 24/29 operacji zapisujących ma schemat request body, 16/19 operacji z parametrem ścieżki dokumentuje parametr, a 0/54 ma stabilny `operationId`. Domyślne globalne bearer auth oraz lokalne wyjątki nie tworzą jawnego, testowalnego profilu ochrony każdej operacji.
- `frontend:client:check` przeszukuje tekst jednego adaptera mobile i jednej strony web. Nie sprawdza metod HTTP, parametrów, request/response schemas ani większości konsumentów administracyjnych.
- Kanonicznym źródłem kontraktu pozostaje backendowy `OPENAPI_DOCUMENT`; wygenerowany JSON jest jego deterministycznym artefaktem. Runtime i konsumenci mają być niezależnie porównywani z tym źródłem, zamiast tworzyć drugi ręczny katalog tras.
- Kryteria akceptacji: dokładna zgodność zbioru metoda+znormalizowana ścieżka runtime z OpenAPI; unikalne `operationId`; jawna klasyfikacja ochrony każdej operacji; komplet parametrów ścieżki; request schema dla każdej operacji przyjmującej JSON; schema co najmniej każdej odpowiedzi sukcesu oraz wspólny zamknięty error envelope dla dokumentowanych błędów; pełny wykaz operacji faktycznie wywoływanych przez mobile i web wraz z metodą; negatywne testy dla brakującej/nadmiarowej operacji, złej metody, brakującego request/response schema, duplikatu `operationId`, błędnej ochrony i nieznanego wywołania konsumenta.
- Nie jest wymagane generowanie klienta ani migracja DTO frontendów, o ile egzekwowalny gate potwierdza ich używany zbiór operacji. Jeśli implementacja ujawni rzeczywisty rozjazd payloadu, należy naprawić najmniejszy odpowiedzialny kontrakt i jego test, a nie dodawać wyjątek.

## Podejście

1. W backendzie wydzielić jeden walidator kompletności OpenAPI oraz test runtime parity oparty na zarejestrowanych trasach Fastify; normalizować `:param` do `{param}` i ignorować automatyczne `HEAD`.
2. Uzupełnić wszystkie operacje OpenAPI o stabilną tożsamość, jawny profil ochrony, brakujące parametry, request bodies i odpowiedzi ze schematami. Wspólne komponenty wykorzystywać wyłącznie tam, gdzie kontrakt jest rzeczywiście wspólny (np. error envelope), zachowując zamknięte obiekty na granicy API.
3. Zastąpić tekstowy checker konsumentów analizą wszystkich zatwierdzonych plików transportowych mobile/web i porównaniem wyekstrahowanych par metoda+znormalizowana ścieżka z OpenAPI; jawnie klasyfikować operacje backend-only (webhook) i diagnostyczne. Dodać fixtures negatywne, żeby gate dowodził odrzucania rozjazdów.
4. Wykonać wąskie testy kontraktu, `openapi:generate`, `openapi:check`, `frontend:client:check`, następnie pełne `npm run ci`; po niezależnym QA bez otwartych problemów zapisać minimalny raport, zaktualizować plan i bezpiecznie opublikować commit.

Ocena przed implementacją (minimum `0,86`): dopasowanie celu/architektury `0,92` — jedno backendowe źródło kontraktu i niezależne porównania; prostota `0,86` — rozszerzenie istniejącego mechanizmu bez generatora klientów; ryzyko `0,88` — negatywne testy oraz pełny gate ograniczają fałszywe zielone wyniki; utrzymywalność `0,90` — wspólny walidator i stabilne identity operacji zastępują grep ścieżek.
