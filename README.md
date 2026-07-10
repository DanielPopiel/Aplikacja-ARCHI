# dobrostanSTUDIOvisualisation

Prywatna aplikacja webowa do wizualizacji i edycji wnętrz (inspirowana raya.design),
marki [dobrostanSTUDIO*](https://dobrostanstudio.com/). Wgrywasz zdjęcie/render,
piszesz polecenia po polsku, a AI edytuje obraz zachowując kompozycję sceny.
Działa na telefonie i komputerze, wdrażana na Vercel.

## Jak to działa

```
polecenie PL ──► Claude (Fable 5) ──► precyzyjny prompt EN ──► FLUX Kontext / Fill / Multi (fal.ai)
+ zaznaczone obszary            widzi obraz + referencje                lub Nano Banana Pro (Google)
+ obiekty referencyjne          + historię edycji                              │
                                                                                ▼
                     Vercel Blob ◄── upscaling do ~2160px (jakość "Wysoka") ◄── wynik
```

- **Claude** — tłumaczy naturalne polecenie na ustrukturyzowany prompt edycyjny wg
  wbudowanego playbooku (usuwanie/zamiana/tekstura/kolor/światło/dodawanie/styl/kadr)
  i generuje jednozdaniowe podsumowanie zmiany do historii. Model przełączany w UI
  (Fable 5 / Opus 4.8 / Sonnet 5); obraz wysyłany do Claude jest zmniejszany do
  ~1024px i liczony na `effort: low`, żeby ciąć koszt tokenów.
- **Zaznaczanie obszarów** — rysujesz prostokąty na obrazie i opisujesz każdy z nich;
  przy FLUX zmiany zawsze wykonuje model inpaintingowy (FLUX.1 Fill) wyłącznie w masce
  — to ma pierwszeństwo nawet gdy dodasz też obiekty referencyjne (patrz niżej), bo
  maska mechanicznie gwarantuje nietykalność reszty zdjęcia. Przy Nano Banana (bez
  natywnej maski) obszary trafiają do promptu jako opis przestrzenny.
- **Obiekty referencyjne** — dodajesz do 4 zdjęć elementów (mebel, lampa, tekstura),
  które mają zostać użyte w edycji. Bez zaznaczonego obszaru, przy FLUX przełącza to
  edycję na model wieloobrazowy (Kontext Max Multi), a Nano Banana przyjmuje je
  natywnie jako dodatkowe obrazy wejściowe. **Z zaznaczonym obszarem przy FLUX**
  zdjęcia referencyjne nie trafiają do modelu graficznego (Fill przyjmuje tylko jeden
  obraz + maskę) — Claude opisuje ich wygląd słownie w promptcie zamiast tego.
- **Jakość** — „Szybka (test)" (FLUX Kontext Pro / Gemini 1K, taniej) to mały,
  szybki podgląd do sprawdzania kierunku zmian; „Wysoka" to wersja finalna
  w **dokładnie tych samych wymiarach co edytowany obraz** (FLUX Kontext Max /
  Gemini 4K + automatyczny upscaling AuraSR, gdy model wygenerował mniej).
  Wgrywane zdjęcia trzymają jakość do 2160×4096px.
- **Kąt kamery** — chipy (niski/wysoki/z lewej/z prawej/detal/szeroki kadr)
  dokładane do promptu.
- **Modele graficzne** — FLUX (fal.ai) i **Nano Banana Pro** (Gemini 3 Pro Image),
  przełączane w UI albo flagą `IMAGE_PROVIDER`. Wspólny interfejs: `lib/providers/`.
- **Historia** — drzewo iteracji (powrót do dowolnej wersji tworzy gałąź) z oceną
  👍/👎 per edycja, synchronizowane między urządzeniami przez Vercel Blob
  (`/api/projects`), z lokalnym cache w `localStorage`. Obrazy trwale w Vercel Blob.
- **Zużycie i budżety** — panel „📊 Zużycie" pokazuje wydatki w tym miesiącu per
  dostawca (Anthropic z licznikiem tokenów, fal.ai, Google), z ręcznie ustawianym
  budżetem/saldem i wskazaniem, który limit jest najbliżej wyczerpania.
- **Autoryzacja** — jedno hasło (`APP_PASSWORD`), cookie sesyjne, `proxy.ts`
  (Next.js 16 middleware).

## Uruchomienie lokalne

```bash
npm install
cp .env.example .env.local   # uzupełnij klucze (patrz komentarze w pliku)
npm run dev                  # http://localhost:3000
```

Bez `APP_PASSWORD` logowanie jest wyłączone (wygodne w dev).
Bez `BLOB_READ_WRITE_TOKEN` obrazy trzymane są jako data-URL (tylko do szybkich testów).

## Wdrożenie na Vercel

1. Wypchnij repo na GitHub: `git push`.
2. Na [vercel.com](https://vercel.com) → **Add New → Project** → zaimportuj to repo
   (framework wykryje się sam: Next.js).
3. **Storage → Create → Blob** i podepnij store do projektu — token
   `BLOB_READ_WRITE_TOKEN` doda się automatycznie.
4. **Settings → Environment Variables** — dodaj klucze z `.env.example`
   (`APP_PASSWORD`, `ANTHROPIC_API_KEY`, `FAL_KEY`, opcjonalnie `GOOGLE_API_KEY`).
5. Deploy. Każdy kolejny `git push` na `main` = automatyczny deploy.

## Zmienne środowiskowe

Pełna lista z opisami i linkami skąd wziąć klucze: [.env.example](.env.example).

| Zmienna | Wymagana | Opis |
|---|---|---|
| `APP_PASSWORD` | prod | Hasło do aplikacji |
| `ANTHROPIC_API_KEY` | tak | Claude — tłumaczenie poleceń |
| `FAL_KEY` | tak | fal.ai — FLUX Kontext/Fill/Multi + upscaling |
| `GOOGLE_API_KEY` | nie | Google AI Studio — Nano Banana Pro |
| `BLOB_READ_WRITE_TOKEN` | prod | Vercel Blob (auto po podpięciu store) |
| `IMAGE_PROVIDER` | nie | Domyślny model graficzny: `flux` / `gemini` |
| `ANTHROPIC_MODEL`, `ANTHROPIC_EFFORT`, `ANTHROPIC_IMAGE_MAX_PX` | nie | Model/koszt tłumaczenia poleceń |
| `FAL_MODEL_STANDARD`, `FAL_MODEL_HIGH`, `FAL_MODEL_FILL`, `FAL_MODEL_MULTI`, `FAL_MODEL_UPSCALE` | nie | Nadpisanie modeli fal.ai |
| `GEMINI_IMAGE_MODEL` | nie | Nadpisanie modelu Gemini |
| `OUTPUT_SHORT_SIDE_PX` | nie | Docelowa rozdzielczość finalna (domyślnie 2160px) |
| `FLUX_STANDARD_COST_USD`, `FLUX_COST_USD`, `FLUX_FILL_COST_USD`, `FLUX_MULTI_COST_USD`, `UPSCALE_COST_USD`, `GEMINI_COST_USD`, `GEMINI_4K_COST_USD` | nie | Stawki do licznika kosztów |

## Struktura

```
app/page.tsx            edytor (upload, czat, obszary, referencje, before/after, historia, eksport)
app/login/page.tsx      logowanie hasłem
app/api/edit/route.ts   pipeline: Claude → model graficzny → upscaling → zapis do Blob
app/api/upload/route.ts upload zdjęcia (klient zachowuje jakość do 2160×4096px)
app/api/projects/route.ts synchronizacja historii/budżetów między urządzeniami
app/api/download/       proxy do eksportu obrazu
lib/claude.ts            warstwa Claude (playbook edycyjny, prompt EN + podsumowanie PL + koszt)
lib/providers/           abstrakcja modeli graficznych (flux-kontext, nano-banana)
lib/upscale.ts           dociąganie do finalnej rozdzielczości (AuraSR / fal.ai)
lib/storage.ts           Vercel Blob (fallback: data URL)
components/UsagePanel.tsx panel zużycia i budżetów
components/Logo.tsx      logo dobrostanSTUDIOvisualisation
proxy.ts                 ochrona hasłem (Next.js 16 middleware)
```

## Uwagi

- Historia projektów żyje w `localStorage` przeglądarki i synchronizuje się do
  Vercel Blob, jeśli token jest ustawiony. Jeśli to kiedyś nie wystarczy,
  naturalny następny krok to lekka baza (Vercel Postgres / Supabase).
- Model `claude-fable-5` wymaga konta z 30-dniową retencją danych (standard).
  Jeśli dostajesz błąd 400 przy każdym poleceniu, ustaw `ANTHROPIC_MODEL=claude-opus-4-8`.
- Generowanie trwa zwykle 10–40 s (Claude + model graficzny + ew. upscaling na
  jakości „Wysoka"); limit funkcji ustawiony na 300 s (`maxDuration`).
