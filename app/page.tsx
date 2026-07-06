"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { EditResponseBody, Project, ProviderName } from "@/lib/types";
import {
  chainSummaries,
  createProject,
  loadProjects,
  nodeById,
  projectCost,
  rootNode,
  saveProjects,
} from "@/lib/client/projects";
import { prepareImageForUpload } from "@/lib/client/image-resize";
import BeforeAfterSlider from "@/components/BeforeAfterSlider";
import HistoryTree from "@/components/HistoryTree";

const PROVIDER_KEY = "archi.provider";

const PRESETS: Array<{ label: string; text: string }> = [
  { label: "☀️ Jaśniej", text: "Dodaj więcej naturalnego światła i rozjaśnij wnętrze" },
  { label: "✨ Nowocześniej", text: "Nadaj wnętrzu bardziej nowoczesny styl, zachowując układ pomieszczenia" },
  { label: "🪵 Podłoga: jasny dąb", text: "Zmień podłogę na deski z jasnego dębu w matowym wykończeniu" },
  { label: "🪴 Dodaj rośliny", text: "Dodaj kilka roślin doniczkowych pasujących stylem do wnętrza" },
  { label: "🧘 Minimalistycznie", text: "Uprość wnętrze w stylu minimalistycznym, usuń zbędne dekoracje" },
  { label: "🕯️ Ciepły wieczór", text: "Zmień oświetlenie na ciepłe, wieczorne i przytulne" },
];

export default function Home() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [provider, setProvider] = useState<ProviderName>("flux");
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState<"upload" | "edit" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [compare, setCompare] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setProjects(loadProjects());
    const savedProvider = window.localStorage.getItem(PROVIDER_KEY);
    if (savedProvider === "flux" || savedProvider === "gemini") setProvider(savedProvider);
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (loaded) saveProjects(projects);
  }, [projects, loaded]);

  useEffect(() => {
    if (loaded) window.localStorage.setItem(PROVIDER_KEY, provider);
  }, [provider, loaded]);

  const active = projects.find((p) => p.id === activeId) ?? null;
  const current = active ? nodeById(active, active.currentNodeId) : null;
  const root = active ? rootNode(active) : null;

  const updateProject = useCallback(
    (id: string, mutate: (p: Project) => Project) => {
      setProjects((prev) => prev.map((p) => (p.id === id ? mutate(p) : p)));
    },
    [],
  );

  async function handleFiles(files: FileList | File[]) {
    const file = Array.from(files).find((f) => f.type.startsWith("image/"));
    if (!file) {
      setError("Wybierz plik graficzny (JPG, PNG, WebP).");
      return;
    }
    setBusy("upload");
    setError(null);
    try {
      const blob = await prepareImageForUpload(file);
      const formData = new FormData();
      formData.append("file", blob, file.name.replace(/\.[^.]+$/, "") + ".jpg");
      const res = await fetch("/api/upload", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Błąd ${res.status}`);

      const name = file.name.replace(/\.[^.]+$/, "") || `Projekt ${new Date().toLocaleDateString("pl-PL")}`;
      const project = createProject(name, data.url);
      setProjects((prev) => [project, ...prev]);
      setActiveId(project.id);
      setCompare(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload nie powiódł się");
    } finally {
      setBusy(null);
    }
  }

  async function handleSend(text: string) {
    const trimmed = text.trim();
    if (!trimmed || !active || !current || busy) return;
    setBusy("edit");
    setError(null);
    const projectId = active.id;
    const parentId = current.id;
    try {
      const res = await fetch("/api/edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageUrl: current.imageUrl,
          instruction: trimmed,
          provider,
          historySummaries: chainSummaries(active, current.id),
        }),
      });
      const data: EditResponseBody & { error?: string } = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Błąd ${res.status}`);

      const newNodeId = crypto.randomUUID();
      updateProject(projectId, (p) => ({
        ...p,
        nodes: [
          ...p.nodes,
          {
            id: newNodeId,
            parentId,
            imageUrl: data.imageUrl,
            instructionPl: trimmed,
            promptEn: data.promptEn,
            summaryPl: data.summaryPl,
            provider: data.provider,
            costUsd: data.costUsd.total,
            createdAt: Date.now(),
          },
        ],
        currentNodeId: newNodeId,
      }));
      setInstruction("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Edycja nie powiodła się");
    } finally {
      setBusy(null);
    }
  }

  function handleExport() {
    if (!current || !active) return;
    const filename = `${active.name}-${current.id.slice(0, 8)}.jpg`;
    if (current.imageUrl.startsWith("data:")) {
      const a = document.createElement("a");
      a.href = current.imageUrl;
      a.download = filename;
      a.click();
    } else {
      window.open(
        `/api/download?url=${encodeURIComponent(current.imageUrl)}&name=${encodeURIComponent(filename)}`,
        "_blank",
      );
    }
  }

  function handleDeleteProject(id: string) {
    if (!window.confirm("Usunąć ten projekt z historii? Obrazy w chmurze pozostaną.")) return;
    setProjects((prev) => prev.filter((p) => p.id !== id));
    if (activeId === id) setActiveId(null);
  }

  if (!loaded) {
    return <main className="flex min-h-dvh items-center justify-center text-neutral-500">Ładowanie…</main>;
  }

  // ---------- Widok listy projektów / uploadu ----------
  if (!active || !current || !root) {
    return (
      <main className="mx-auto w-full max-w-3xl flex-1 p-4 sm:p-8">
        <header className="mb-6">
          <h1 className="text-2xl font-bold">ARCHI</h1>
          <p className="text-sm text-neutral-400">Wizualizacja i edycja wnętrz z pomocą AI</p>
        </header>

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            handleFiles(e.dataTransfer.files);
          }}
          className={`mb-4 flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed p-8 text-center transition-colors ${
            dragOver ? "border-emerald-500 bg-emerald-500/10" : "border-neutral-700 bg-neutral-900"
          }`}
        >
          <p className="text-lg font-medium">Wgraj zdjęcie lub render wnętrza</p>
          <p className="text-sm text-neutral-400">Przeciągnij i upuść plik albo wybierz poniżej</p>
          <div className="flex flex-wrap justify-center gap-2">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => fileInputRef.current?.click()}
              className="rounded-lg bg-emerald-600 px-4 py-2 font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              {busy === "upload" ? "Wgrywanie…" : "Wybierz plik"}
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => cameraInputRef.current?.click()}
              className="rounded-lg border border-neutral-600 px-4 py-2 font-medium hover:border-neutral-400 disabled:opacity-50"
            >
              📷 Zrób zdjęcie
            </button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => e.target.files && handleFiles(e.target.files)}
          />
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => e.target.files && handleFiles(e.target.files)}
          />
        </div>

        {error && (
          <p className="mb-4 rounded-lg border border-red-800 bg-red-950/60 p-3 text-sm text-red-300">
            {error}
          </p>
        )}

        {projects.length > 0 && (
          <section>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-400">
              Twoje projekty
            </h2>
            <ul className="grid gap-3 sm:grid-cols-2">
              {projects.map((p) => {
                const cur = nodeById(p, p.currentNodeId) ?? rootNode(p);
                return (
                  <li
                    key={p.id}
                    className="group relative overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900"
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setActiveId(p.id);
                        setCompare(false);
                        setError(null);
                      }}
                      className="block w-full text-left"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={cur.imageUrl}
                        alt={p.name}
                        className="h-40 w-full object-cover"
                        loading="lazy"
                      />
                      <div className="p-3">
                        <p className="truncate font-medium">{p.name}</p>
                        <p className="text-xs text-neutral-400">
                          {p.nodes.length - 1} edycji · ${projectCost(p).toFixed(2)} ·{" "}
                          {new Date(p.createdAt).toLocaleDateString("pl-PL")}
                        </p>
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteProject(p.id)}
                      title="Usuń projekt"
                      className="absolute right-2 top-2 rounded-md bg-black/60 px-2 py-1 text-xs text-neutral-300 opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100"
                    >
                      Usuń
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </main>
    );
  }

  // ---------- Widok edytora ----------
  const isRootCurrent = current.id === root.id;
  const totalCost = projectCost(active);

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col p-3 sm:p-6">
      <header className="mb-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setActiveId(null)}
          className="rounded-lg border border-neutral-700 px-3 py-1.5 text-sm hover:border-neutral-500"
        >
          ← Projekty
        </button>
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">{active.name}</h1>
        <span
          title="Łączny koszt generowania w tym projekcie"
          className="rounded-full border border-amber-700/60 bg-amber-950/40 px-3 py-1 text-sm text-amber-300"
        >
          💰 ${totalCost.toFixed(3)}
        </span>
      </header>

      <div className="grid flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        {/* Obraz */}
        <section className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setCompare((c) => !c)}
              disabled={isRootCurrent}
              className={`rounded-lg border px-3 py-1.5 text-sm transition-colors disabled:opacity-40 ${
                compare
                  ? "border-emerald-500 bg-emerald-500/10 text-emerald-300"
                  : "border-neutral-700 hover:border-neutral-500"
              }`}
            >
              ⇄ Przed / Po
            </button>
            <button
              type="button"
              onClick={handleExport}
              className="rounded-lg border border-neutral-700 px-3 py-1.5 text-sm hover:border-neutral-500"
            >
              ⬇️ Pobierz
            </button>
            <div className="ml-auto flex items-center gap-1.5 text-sm">
              <span className="text-neutral-400">Model:</span>
              <select
                value={provider}
                onChange={(e) => setProvider(e.target.value as ProviderName)}
                className="rounded-lg border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm outline-none focus:border-emerald-500"
              >
                <option value="flux">FLUX Kontext Max</option>
                <option value="gemini">Nano Banana Pro</option>
              </select>
            </div>
          </div>

          <div className="relative">
            {compare && !isRootCurrent ? (
              <BeforeAfterSlider beforeUrl={root.imageUrl} afterUrl={current.imageUrl} />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={current.imageUrl}
                alt="Aktualna wersja wnętrza"
                className="block w-full rounded-xl bg-neutral-900"
              />
            )}
            {busy === "edit" && (
              <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-black/60 backdrop-blur-sm">
                <div className="text-center">
                  <div className="mx-auto mb-3 h-8 w-8 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
                  <p className="text-sm text-neutral-200">Generowanie edycji…</p>
                  <p className="text-xs text-neutral-400">Claude tłumaczy polecenie, potem model graficzny pracuje</p>
                </div>
              </div>
            )}
          </div>

          {current.promptEn && (
            <details className="mt-2 text-xs text-neutral-500">
              <summary className="cursor-pointer select-none">Prompt wysłany do modelu graficznego</summary>
              <p className="mt-1 rounded-lg bg-neutral-900 p-2 font-mono">{current.promptEn}</p>
            </details>
          )}
        </section>

        {/* Panel boczny: polecenia + historia */}
        <aside className="flex min-w-0 flex-col gap-4">
          <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-3">
            <div className="mb-2 flex flex-wrap gap-1.5">
              {PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  disabled={busy !== null}
                  onClick={() => setInstruction(preset.text)}
                  className="rounded-full border border-neutral-700 px-2.5 py-1 text-xs text-neutral-300 hover:border-emerald-600 hover:text-emerald-300 disabled:opacity-50"
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleSend(instruction);
              }}
            >
              <textarea
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSend(instruction);
                  }
                }}
                placeholder="Opisz zmianę po polsku, np. zmień podłogę na jasny dąb i dodaj więcej światła…"
                rows={3}
                disabled={busy !== null}
                className="w-full resize-none rounded-lg border border-neutral-700 bg-neutral-800 p-2.5 text-sm outline-none focus:border-emerald-500 disabled:opacity-60"
              />
              <button
                type="submit"
                disabled={busy !== null || !instruction.trim()}
                className="mt-2 w-full rounded-lg bg-emerald-600 py-2 font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
              >
                {busy === "edit" ? "Generowanie…" : "Zastosuj edycję"}
              </button>
            </form>
            {error && (
              <p className="mt-2 rounded-lg border border-red-800 bg-red-950/60 p-2 text-xs text-red-300">
                {error}
              </p>
            )}
          </div>

          <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-3">
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-neutral-400">
              Historia iteracji
            </h2>
            <p className="mb-2 text-xs text-neutral-500">
              Kliknij wcześniejszą wersję, aby do niej wrócić — kolejna edycja utworzy nową gałąź.
            </p>
            <div className="max-h-[50vh] overflow-y-auto pr-1">
              <HistoryTree
                project={active}
                disabled={busy !== null}
                onSelect={(nodeId) => {
                  updateProject(active.id, (p) => ({ ...p, currentNodeId: nodeId }));
                  setCompare(false);
                }}
              />
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}
