# ARCHI — edytor wnętrz AI

Prywatna aplikacja webowa do wizualizacji i edycji wnętrz (inspirowana raya.design).
Wgrywasz zdjęcie/render, piszesz polecenia po polsku, a AI edytuje obraz zachowując
kompozycję sceny. Działa na telefonie i komputerze, wdrażana na Vercel.

## Jak to działa

```
polecenie PL ──► Claude (Fable 5) ──► precyzyjny prompt EN ──► FLUX Kontext Max (fal.ai)
                 widzi aktualny obraz                          lub Nano Banana Pro (Google)
                 + historię edycji                                    │
                                                                      ▼
                          Vercel Blob ◄── zapis wyniku ◄── nowy węzeł w historii
```

- **Claude (Fable 5)** — tłumaczy naturalne polecenie na ustrukturyzowany prompt edycyjny
  i generuje jednozdaniowe podsumowanie zmiany do historii.
- **FLUX.1 Kontext [Max]** (fal.ai) — główny model edycji obrazu; **Nano Banana Pro**
  (Gemini 3 Pro Image, Google AI Studio) — fallback. Przełącznik w UI albo flaga
  `IMAGE_PROVIDER` w env. Wspólny interfejs: `lib/providers/` (`generateEdit`).
- **Historia** — drzewo iteracji w `localStorage` (możesz wrócić do dowolnej wersji
  i kontynuować — powstaje gałąź). Obrazy trwale w Vercel Blob.
- **Koszty** — licznik $ przy każdym węźle i sumarycznie per projekt
  (Claude wg tokenów + stała stawka za obraz, konfigurowalna w env).
- **Autoryzacja** — jedno hasło (`APP_PASSWORD`), cookie sesyjne, middleware.

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
| `FAL_KEY` | tak | fal.ai — FLUX Kontext |
| `GOOGLE_API_KEY` | nie | Google AI Studio — Nano Banana Pro |
| `BLOB_READ_WRITE_TOKEN` | prod | Vercel Blob (auto po podpięciu store) |
| `IMAGE_PROVIDER` | nie | Domyślny model graficzny: `flux` / `gemini` |
| `ANTHROPIC_MODEL`, `FAL_MODEL`, `GEMINI_IMAGE_MODEL` | nie | Nadpisanie modeli |
| `FLUX_COST_USD`, `GEMINI_COST_USD` | nie | Stawki do licznika kosztów |

## Struktura

```
app/page.tsx            edytor (upload, czat, before/after, historia, presety, eksport)
app/login/page.tsx      logowanie hasłem
app/api/edit/route.ts   pipeline: Claude → model graficzny → zapis do Blob
app/api/upload/route.ts upload zdjęcia (klient zmniejsza obraz do 2048px przed wysyłką)
app/api/download/       proxy do eksportu obrazu
lib/claude.ts           warstwa Fable 5 (prompt EN + podsumowanie PL + koszt)
lib/providers/          abstrakcja modeli graficznych (flux-kontext, nano-banana)
lib/storage.ts          Vercel Blob (fallback: data URL)
middleware.ts           ochrona hasłem
```

## Uwagi

- Historia projektów żyje w `localStorage` przeglądarki — wyczyszczenie danych
  witryny usuwa listę projektów (obrazy w Blob zostają). Jeśli zacznie to
  przeszkadzać, naturalny następny krok to lekka baza (Vercel Postgres / Supabase).
- Model `claude-fable-5` wymaga konta z 30-dniową retencją danych (standard).
  Jeśli dostajesz błąd 400 przy każdym poleceniu, ustaw `ANTHROPIC_MODEL=claude-opus-4-8`.
- Generowanie trwa zwykle 10–30 s (Claude + model graficzny); limit funkcji
  ustawiony na 300 s (`maxDuration`).
