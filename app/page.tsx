"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Budgets,
  CameraAngle,
  EditArea,
  EditResponseBody,
  Project,
  ProjectsDocument,
  ProviderName,
  Quality,
  ReferenceObject,
} from "@/lib/types";
import {
  chainSummaries,
  createProject,
  loadBudgets,
  loadDeletedIds,
  loadProjects,
  mergeDocuments,
  nodeById,
  projectCost,
  rootNode,
  saveBudgets,
  saveDeletedIds,
  saveProjects,
} from "@/lib/client/projects";
import UsagePanel from "@/components/UsagePanel";
import { prepareImageForUpload, prepareReferenceForUpload } from "@/lib/client/image-resize";
import { buildMaskBlob } from "@/lib/client/mask";
import BeforeAfterSlider from "@/components/BeforeAfterSlider";
import EditorCanvas from "@/components/EditorCanvas";
import HistoryTree from "@/components/HistoryTree";
import Logo from "@/components/Logo";

const PREFS_KEY = "archi.prefs.v1";
const MAX_INSTRUCTION = 500;

interface Prefs {
  provider: ProviderName;
  quality: Quality;
  claudeModel: string;
}

const DEFAULT_PREFS: Prefs = {
  provider: "flux",
  quality: "standard",
  claudeModel: "claude-fable-5",
};

const CAMERA_ANGLES: Array<{ value: CameraAngle; label: string; icon: string }> = [
  { value: "low", label: "Niski kąt", icon: "↑" },
  { value: "high", label: "Wysoki kąt", icon: "↓" },
  { value: "left", label: "Z lewej", icon: "→" },
  { value: "right", label: "Z prawej", icon: "←" },
  { value: "detail", label: "Detal", icon: "⊕" },
  { value: "wide", label: "Szeroki kadr", icon: "⊖" },
];

const CLAUDE_MODELS: Array<{ value: string; label: string }> = [
  { value: "claude-fable-5", label: "Claude Fable 5 — najlepsze prompty" },
  { value: "claude-opus-4-8", label: "Claude Opus 4.8 — tańszy" },
  { value: "claude-sonnet-5", label: "Claude Sonnet 5 — najszybszy" },
];

function sectionLabel(text: string, optional = false) {
  return (
    <div className="mb-2 flex items-baseline justify-between">
      <h3 className="text-sm font-bold text-[#1A1A1A]">{text}</h3>
      {optional && <span className="text-xs text-[#a5a29a]">(opcjonalnie)</span>}
    </div>
  );
}

export default function Home() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [deletedIds, setDeletedIds] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);

  const [instruction, setInstruction] = useState("");
  const [areas, setAreas] = useState<EditArea[]>([]);
  const [drawMode, setDrawMode] = useState(false);
  const [cameraAngle, setCameraAngle] = useState<CameraAngle | null>(null);
  const [referenceObjects, setReferenceObjects] = useState<ReferenceObject[]>([]);
  const [refBusy, setRefBusy] = useState(false);

  const [busy, setBusy] = useState<"upload" | "edit" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [compare, setCompare] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [budgets, setBudgets] = useState<Budgets | null>(null);
  const [usageOpen, setUsageOpen] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const refInputRef = useRef<HTMLInputElement>(null);
  const remoteSyncRef = useRef(false);

  // --- Load: localStorage + cross-device sync from Blob ---
  useEffect(() => {
    (async () => {
      let doc: ProjectsDocument = {
        projects: loadProjects(),
        deletedIds: loadDeletedIds(),
        budgets: loadBudgets(),
      };
      try {
        const res = await fetch("/api/projects", { cache: "no-store" });
        if (res.ok) {
          const remote = await res.json();
          if (remote.synced) {
            doc = mergeDocuments(doc, {
              projects: remote.projects ?? [],
              deletedIds: remote.deletedIds ?? [],
              budgets: remote.budgets ?? null,
            });
            remoteSyncRef.current = true;
          }
        }
      } catch {
        /* offline / no blob — localStorage only */
      }
      try {
        const rawPrefs = window.localStorage.getItem(PREFS_KEY);
        if (rawPrefs) setPrefs({ ...DEFAULT_PREFS, ...JSON.parse(rawPrefs) });
      } catch {
        /* ignore */
      }
      setProjects(doc.projects);
      setDeletedIds(doc.deletedIds);
      setBudgets(doc.budgets ?? null);
      saveProjects(doc.projects);
      saveDeletedIds(doc.deletedIds);
      saveBudgets(doc.budgets ?? null);
      setLoaded(true);
    })();
  }, []);

  // --- Persist: localStorage immediately, Blob debounced ---
  useEffect(() => {
    if (!loaded) return;
    saveProjects(projects);
    saveDeletedIds(deletedIds);
    saveBudgets(budgets);
    if (!remoteSyncRef.current) return;
    const t = setTimeout(() => {
      fetch("/api/projects", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projects, deletedIds, budgets }),
      }).catch(() => {});
    }, 1200);
    return () => clearTimeout(t);
  }, [projects, deletedIds, budgets, loaded]);

  useEffect(() => {
    if (loaded) window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  }, [prefs, loaded]);

  const active = projects.find((p) => p.id === activeId) ?? null;
  const current = active ? nodeById(active, active.currentNodeId) : null;
  const root = active ? rootNode(active) : null;

  // Areas/camera relate to a specific image — reset when the image changes.
  const currentImageUrl = current?.imageUrl;
  useEffect(() => {
    setAreas([]);
    setDrawMode(false);
    setCameraAngle(null);
    setCompare(false);
    setError(null);
  }, [activeId, currentImageUrl]);

  // Reference objects are often reused across edits — reset only per project.
  useEffect(() => {
    setReferenceObjects([]);
  }, [activeId]);

  const updateProject = useCallback((id: string, mutate: (p: Project) => Project) => {
    setProjects((prev) =>
      prev.map((p) => (p.id === id ? { ...mutate(p), updatedAt: Date.now() } : p)),
    );
  }, []);

  async function uploadBlob(blob: Blob, filename: string): Promise<string> {
    const formData = new FormData();
    formData.append("file", blob, filename);
    const res = await fetch("/api/upload", { method: "POST", body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `Błąd ${res.status}`);
    return data.url as string;
  }

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
      const url = await uploadBlob(blob, file.name.replace(/\.[^.]+$/, "") + ".jpg");
      const name =
        file.name.replace(/\.[^.]+$/, "") || `Projekt ${new Date().toLocaleDateString("pl-PL")}`;
      const project = createProject(name, url);
      setProjects((prev) => [project, ...prev]);
      setActiveId(project.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload nie powiódł się");
    } finally {
      setBusy(null);
    }
  }

  async function handleAddReference(file: File) {
    if (referenceObjects.length >= 4) return;
    setRefBusy(true);
    setError(null);
    try {
      const blob = await prepareReferenceForUpload(file);
      const url = await uploadBlob(blob, "reference.jpg");
      setReferenceObjects((prev) => [...prev, { imageUrl: url, description: "" }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Nie udało się wgrać obiektu");
    } finally {
      setRefBusy(false);
    }
  }

  const canSubmit =
    instruction.trim().length > 0 ||
    areas.some((a) => a.description.trim()) ||
    referenceObjects.length > 0 ||
    cameraAngle !== null;

  async function handleSend() {
    if (!canSubmit || !active || !current || busy) return;
    setBusy("edit");
    setError(null);
    setDrawMode(false);
    const projectId = active.id;
    const parentId = current.id;
    try {
      // Reference objects route FLUX to its multi-image model, which has no
      // mask input — skip building one to avoid a wasted upload.
      let maskUrl: string | undefined;
      if (prefs.provider === "flux" && areas.length > 0 && referenceObjects.length === 0) {
        const maskBlob = await buildMaskBlob(current.imageUrl, areas);
        maskUrl = await uploadBlob(maskBlob, "mask.png");
      }

      const res = await fetch("/api/edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageUrl: current.imageUrl,
          instruction: instruction.trim(),
          provider: prefs.provider,
          quality: prefs.quality,
          claudeModel: prefs.claudeModel,
          cameraAngle,
          areas,
          maskUrl,
          referenceObjects,
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
            instructionPl:
              instruction.trim() ||
              areas
                .map((a) => a.description.trim())
                .filter(Boolean)
                .join("; ") ||
              "Zmiana kadru",
            promptEn: data.promptEn,
            summaryPl: data.summaryPl,
            provider: data.provider,
            quality: data.quality,
            costUsd: data.costUsd.total,
            costClaudeUsd: data.costUsd.claude,
            costImageUsd: data.costUsd.image,
            tokensIn: data.claudeTokens?.input,
            tokensOut: data.claudeTokens?.output,
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

  function handleRate(rating: "up" | "down") {
    if (!active || !current) return;
    const nodeId = current.id;
    updateProject(active.id, (p) => ({
      ...p,
      nodes: p.nodes.map((n) =>
        n.id === nodeId ? { ...n, rating: n.rating === rating ? undefined : rating } : n,
      ),
    }));
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
    setDeletedIds((prev) => [...prev, id]);
    if (activeId === id) setActiveId(null);
  }

  // Estimated image cost for the quality cards (Claude cost comes on top).
  const imageCost = (q: Quality): string => {
    if (prefs.provider === "gemini") return "≈$0.14";
    if (areas.length > 0) return "≈$0.05";
    return q === "high" ? "≈$0.08" : "≈$0.04";
  };

  if (!loaded) {
    return (
      <main className="flex min-h-dvh items-center justify-center text-[#8a887f]">
        Ładowanie…
      </main>
    );
  }

  // ============ Widok listy projektów / uploadu ============
  if (!active || !current || !root) {
    return (
      <main className="mx-auto w-full max-w-4xl flex-1 p-4 sm:p-8">
        <header className="mb-6 flex flex-wrap items-start justify-between gap-2">
          <div>
            <Logo variant="full" />
            <p className="mt-1 text-sm text-[#8a887f]">Wizualizacja i edycja wnętrz z pomocą AI</p>
          </div>
          <button
            type="button"
            onClick={() => setUsageOpen(true)}
            className="rounded-xl border border-[#dcd9d1] bg-white px-3 py-1.5 text-sm font-medium text-[#1A1A1A] hover:border-[#cdbf7a]"
          >
            📊 Zużycie
          </button>
        </header>
        {usageOpen && (
          <UsagePanel
            projects={projects}
            budgets={budgets}
            onBudgetsChange={setBudgets}
            onClose={() => setUsageOpen(false)}
          />
        )}

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
          className={`mb-4 flex flex-col items-center justify-center gap-3 rounded-3xl border-2 border-dashed bg-white p-10 text-center transition-colors ${
            dragOver ? "border-[#b9a646] bg-[#f6f2e3]" : "border-[#dcd9d1]"
          }`}
        >
          <p className="text-2xl font-semibold text-[#1A1A1A]">
            Wgraj <span className="italic">zdjęcie</span> wnętrza
          </p>
          <p className="text-sm text-[#8a887f]">
            Przeciągnij i upuść plik albo wybierz poniżej · JPG, PNG, WebP
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => fileInputRef.current?.click()}
              className="rounded-xl bg-[#50344f] px-5 py-2.5 font-semibold text-white shadow-sm transition-colors hover:bg-[#684366] disabled:opacity-50"
            >
              {busy === "upload" ? "Wgrywanie…" : "Wybierz plik"}
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => cameraInputRef.current?.click()}
              className="rounded-xl border border-[#dcd9d1] bg-white px-5 py-2.5 font-semibold text-[#1A1A1A] transition-colors hover:border-[#cdbf7a] disabled:opacity-50"
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
          <p className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-600">
            {error}
          </p>
        )}

        {projects.length > 0 && (
          <section>
            <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-[#8a887f]">
              Twoje wizualizacje
            </h2>
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {projects.map((p) => {
                const cur = nodeById(p, p.currentNodeId) ?? rootNode(p);
                return (
                  <li
                    key={p.id}
                    className="group relative overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-[#e8e6df] transition-shadow hover:shadow-md"
                  >
                    <button
                      type="button"
                      onClick={() => setActiveId(p.id)}
                      className="block w-full text-left"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={cur.imageUrl}
                        alt={p.name}
                        className="h-40 w-full bg-[#efede7] object-cover"
                        loading="lazy"
                      />
                      <div className="p-3">
                        <p className="truncate font-semibold text-[#1A1A1A]">{p.name}</p>
                        <p className="text-xs text-[#8a887f]">
                          {p.nodes.length - 1} edycji · ${projectCost(p).toFixed(2)} ·{" "}
                          {new Date(p.updatedAt).toLocaleDateString("pl-PL")}
                        </p>
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteProject(p.id)}
                      title="Usuń projekt"
                      className="absolute right-2 top-2 rounded-lg bg-white/90 px-2 py-1 text-xs text-[#8a887f] opacity-0 shadow transition-opacity hover:text-red-500 group-hover:opacity-100"
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

  // ============ Widok edytora ============
  const isRootCurrent = current.id === root.id;
  const totalCost = projectCost(active);

  return (
    <main className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col p-3 sm:p-5">
      <header className="mb-4 flex flex-wrap items-center gap-2">
        <Logo />
        <button
          type="button"
          onClick={() => setActiveId(null)}
          className="rounded-xl border border-[#dcd9d1] bg-white px-3 py-1.5 text-sm font-medium text-[#1A1A1A] hover:border-[#cdbf7a]"
        >
          ← Projekty
        </button>
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold text-[#55534d]">
          {active.name}
        </h1>
        <span
          title="Łączny koszt generowania w tym projekcie"
          className="rounded-full bg-amber-100 px-3 py-1 text-sm font-semibold text-amber-700 ring-1 ring-amber-200"
        >
          💰 ${totalCost.toFixed(3)}
        </span>
        <button
          type="button"
          onClick={() => setUsageOpen(true)}
          title="Zużycie i budżety"
          className="rounded-xl border border-[#dcd9d1] bg-white px-3 py-1.5 text-sm font-medium text-[#1A1A1A] hover:border-[#cdbf7a]"
        >
          📊
        </button>
      </header>
      {usageOpen && (
        <UsagePanel
          projects={projects}
          budgets={budgets}
          onBudgetsChange={setBudgets}
          onClose={() => setUsageOpen(false)}
        />
      )}

      <div className="grid flex-1 gap-4 lg:grid-cols-[260px_minmax(0,1fr)_360px]">
        {/* Historia (lewa kolumna) */}
        <aside className="order-3 min-w-0 lg:order-1">
          <div className="rounded-2xl bg-white p-3 shadow-sm ring-1 ring-[#e8e6df]">
            <h2 className="mb-1 text-sm font-bold text-[#1A1A1A]">Historia</h2>
            <p className="mb-2 text-xs text-[#a5a29a]">
              Kliknij wersję, aby do niej wrócić — kolejna edycja utworzy gałąź.
            </p>
            <div className="max-h-[60vh] overflow-y-auto pr-1 lg:max-h-[calc(100vh-180px)]">
              <HistoryTree
                project={active}
                disabled={busy !== null}
                onSelect={(nodeId) =>
                  updateProject(active.id, (p) => ({ ...p, currentNodeId: nodeId }))
                }
              />
            </div>
          </div>
        </aside>

        {/* Obraz (środek) */}
        <section className="order-1 min-w-0 lg:order-2">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setCompare((c) => !c)}
              disabled={isRootCurrent}
              className={`rounded-xl border px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-40 ${
                compare
                  ? "border-[#b9a646] bg-[#f6f2e3] text-[#50344f]"
                  : "border-[#dcd9d1] bg-white text-[#1A1A1A] hover:border-[#cdbf7a]"
              }`}
            >
              ⇄ Przed / Po
            </button>
            <button
              type="button"
              onClick={handleExport}
              className="rounded-xl border border-[#dcd9d1] bg-white px-3 py-1.5 text-sm font-medium text-[#1A1A1A] hover:border-[#cdbf7a]"
            >
              ⬇️ Pobierz
            </button>
            {!isRootCurrent && (
              <div className="flex items-center gap-1" title="Oceń tę edycję — oceny pomagają dopracować reguły promptowania">
                <button
                  type="button"
                  onClick={() => handleRate("up")}
                  className={`rounded-xl border px-2.5 py-1.5 text-sm transition-colors ${
                    current.rating === "up"
                      ? "border-emerald-400 bg-emerald-50"
                      : "border-[#dcd9d1] bg-white hover:border-emerald-300"
                  }`}
                >
                  👍
                </button>
                <button
                  type="button"
                  onClick={() => handleRate("down")}
                  className={`rounded-xl border px-2.5 py-1.5 text-sm transition-colors ${
                    current.rating === "down"
                      ? "border-red-400 bg-red-50"
                      : "border-[#dcd9d1] bg-white hover:border-red-300"
                  }`}
                >
                  👎
                </button>
              </div>
            )}
          </div>

          <div className="relative">
            {compare && !isRootCurrent ? (
              <BeforeAfterSlider beforeUrl={root.imageUrl} afterUrl={current.imageUrl} />
            ) : (
              <EditorCanvas
                imageUrl={current.imageUrl}
                areas={areas}
                drawMode={drawMode && busy === null}
                onAddArea={(rect) => {
                  setAreas((prev) => [...prev, { ...rect, description: "" }]);
                  setDrawMode(false);
                }}
                onRemoveArea={(index) => setAreas((prev) => prev.filter((_, i) => i !== index))}
              />
            )}
            {busy === "edit" && (
              <div className="absolute inset-0 flex items-center justify-center rounded-2xl bg-white/70 backdrop-blur-sm">
                <div className="text-center">
                  <div className="mx-auto mb-3 h-8 w-8 animate-spin rounded-full border-2 border-[#b9a646] border-t-transparent" />
                  <p className="text-sm font-medium text-[#1A1A1A]">Generowanie edycji…</p>
                  <p className="text-xs text-[#8a887f]">
                    Claude tłumaczy polecenie, potem model graficzny pracuje
                  </p>
                </div>
              </div>
            )}
          </div>

          {current.promptEn && (
            <details className="mt-2 text-xs text-[#8a887f]">
              <summary className="cursor-pointer select-none">
                Prompt wysłany do modelu graficznego
              </summary>
              <p className="mt-1 rounded-xl bg-white p-2 font-mono ring-1 ring-[#e8e6df]">
                {current.promptEn}
              </p>
            </details>
          )}
        </section>

        {/* Panel sterowania (prawa kolumna) */}
        <aside className="order-2 min-w-0 lg:order-3">
          <div className="flex flex-col gap-5 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-[#e8e6df]">
            {/* Polecenie */}
            <div>
              {sectionLabel("Co chcesz zmienić?")}
              <div className="relative">
                <textarea
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value.slice(0, MAX_INSTRUCTION))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                  placeholder="np. zmień porę dnia na zachód słońca, usuń krzesło, pomaluj ściany na biało…"
                  rows={4}
                  maxLength={MAX_INSTRUCTION}
                  disabled={busy !== null}
                  className="w-full resize-none rounded-xl border border-[#dcd9d1] bg-white p-3 pb-6 text-sm text-[#1A1A1A] outline-none placeholder:text-[#b8b5ac] focus:border-[#b9a646] disabled:opacity-60"
                />
                <span className="pointer-events-none absolute bottom-2.5 right-3 text-[11px] text-[#b8b5ac]">
                  {instruction.length}/{MAX_INSTRUCTION}
                </span>
              </div>
            </div>

            {/* Kąt kamery */}
            <div>
              {sectionLabel("Kąt kamery", true)}
              <div className="grid grid-cols-3 gap-2">
                {CAMERA_ANGLES.map((angle) => {
                  const activeChip = cameraAngle === angle.value;
                  return (
                    <button
                      key={angle.value}
                      type="button"
                      disabled={busy !== null}
                      onClick={() => setCameraAngle(activeChip ? null : angle.value)}
                      className={`flex flex-col items-center gap-0.5 rounded-xl border px-2 py-2.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                        activeChip
                          ? "border-[#b9a646] bg-[#f6f2e3] text-[#50344f]"
                          : "border-[#dcd9d1] bg-white text-[#55534d] hover:border-[#cdbf7a]"
                      }`}
                    >
                      <span className="text-base leading-none">{angle.icon}</span>
                      {angle.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Zaznacz obszar */}
            <div>
              {sectionLabel("Zaznacz obszar", true)}
              <p className="mb-2 text-xs text-[#8a887f]">
                Zaznacz miejsca na obrazie i opisz, co ma się w nich zmienić. Zaznaczaj z
                zapasem — obejmij też cień i poświatę obiektu.
                {prefs.provider === "flux" && areas.length > 0 && (
                  <span className="text-[#50344f]"> Zmiany obejmą tylko zaznaczenia (inpainting).</span>
                )}
              </p>
              <div className="flex flex-col gap-2">
                {areas.map((area, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#50344f] text-[11px] font-bold text-white">
                      {i + 1}
                    </span>
                    <input
                      type="text"
                      value={area.description}
                      disabled={busy !== null}
                      onChange={(e) =>
                        setAreas((prev) =>
                          prev.map((a, j) => (j === i ? { ...a, description: e.target.value } : a)),
                        )
                      }
                      placeholder="Opisz zmianę w tym obszarze…"
                      className="min-w-0 flex-1 rounded-xl border border-[#dcd9d1] bg-white px-3 py-2 text-sm text-[#1A1A1A] outline-none placeholder:text-[#b8b5ac] focus:border-[#b9a646] disabled:opacity-60"
                    />
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => setAreas((prev) => prev.filter((_, j) => j !== i))}
                      title="Usuń zaznaczenie"
                      className="text-[#a5a29a] hover:text-red-500"
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  disabled={busy !== null || compare}
                  onClick={() => setDrawMode((d) => !d)}
                  className={`rounded-xl border-2 border-dashed px-3 py-2 text-sm font-medium transition-colors disabled:opacity-50 ${
                    drawMode
                      ? "border-[#b9a646] bg-[#f6f2e3] text-[#50344f]"
                      : "border-[#dcd9d1] text-[#55534d] hover:border-[#cdbf7a]"
                  }`}
                >
                  {drawMode ? "Rysuj prostokąt na obrazie…" : "+ Dodaj zaznaczenie"}
                </button>
              </div>
            </div>

            {/* Obiekty referencyjne */}
            <div>
              {sectionLabel("Obiekty referencyjne", true)}
              <p className="mb-2 text-xs text-[#8a887f]">
                Dodaj zdjęcia elementów, których chcesz użyć w edycji (np. lampa, mebel,
                tekstura) — maks. 4.
              </p>
              <div className="flex flex-col gap-2">
                {referenceObjects.map((ref, i) => (
                  <div key={i} className="flex items-center gap-2">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={ref.imageUrl}
                      alt={`Obiekt referencyjny ${i + 1}`}
                      className="h-11 w-11 shrink-0 rounded-lg border border-[#dcd9d1] object-cover"
                    />
                    <input
                      type="text"
                      value={ref.description}
                      disabled={busy !== null}
                      onChange={(e) =>
                        setReferenceObjects((prev) =>
                          prev.map((r, j) =>
                            j === i ? { ...r, description: e.target.value } : r,
                          ),
                        )
                      }
                      placeholder="Opisz ten obiekt…"
                      className="min-w-0 flex-1 rounded-xl border border-[#dcd9d1] bg-white px-3 py-2 text-sm text-[#1A1A1A] outline-none placeholder:text-[#b8b5ac] focus:border-[#b9a646] disabled:opacity-60"
                    />
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() =>
                        setReferenceObjects((prev) => prev.filter((_, j) => j !== i))
                      }
                      title="Usuń obiekt referencyjny"
                      className="text-[#a5a29a] hover:text-red-500"
                    >
                      ✕
                    </button>
                  </div>
                ))}
                {referenceObjects.length < 4 && (
                  <button
                    type="button"
                    disabled={busy !== null || refBusy}
                    onClick={() => refInputRef.current?.click()}
                    className="flex items-center justify-center gap-2 rounded-xl border-2 border-dashed border-[#dcd9d1] px-3 py-2.5 text-sm font-medium text-[#55534d] transition-colors hover:border-[#cdbf7a] disabled:opacity-50"
                  >
                    {refBusy ? "Wgrywanie…" : "+ Dodaj obiekt referencyjny"}
                  </button>
                )}
                <input
                  ref={refInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    if (e.target.files?.[0]) handleAddReference(e.target.files[0]);
                    e.target.value = "";
                  }}
                />
              </div>
            </div>

            {/* Jakość */}
            <div>
              {sectionLabel("Jakość")}
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => setPrefs((p) => ({ ...p, quality: "standard" }))}
                  className={`flex items-center justify-between rounded-xl border px-3 py-2.5 text-left transition-colors disabled:opacity-50 ${
                    prefs.quality === "standard"
                      ? "border-[#b9a646] bg-[#f6f2e3]"
                      : "border-[#dcd9d1] bg-white hover:border-[#cdbf7a]"
                  }`}
                >
                  <span>
                    <span className="block text-sm font-semibold text-[#1A1A1A]">⚡ Szybka (test)</span>
                    <span className="block text-xs text-[#8a887f]">
                      Do sprawdzenia, czy zmiana idzie w dobrą stronę
                    </span>
                  </span>
                  <span className="shrink-0 rounded-full bg-[#efede7] px-2 py-0.5 text-xs font-semibold text-[#55534d]">
                    {imageCost("standard")}
                  </span>
                </button>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => setPrefs((p) => ({ ...p, quality: "high" }))}
                  className={`flex items-center justify-between rounded-xl border px-3 py-2.5 text-left transition-colors disabled:opacity-50 ${
                    prefs.quality === "high"
                      ? "border-[#b9a646] bg-[#f6f2e3]"
                      : "border-[#dcd9d1] bg-white hover:border-[#cdbf7a]"
                  }`}
                >
                  <span>
                    <span className="block text-sm font-semibold text-[#1A1A1A]">✨ Wysoka</span>
                    <span className="block text-xs text-[#8a887f]">
                      Maksymalna jakość i realizm — wersja finalna
                    </span>
                  </span>
                  <span className="shrink-0 rounded-full bg-[#efede7] px-2 py-0.5 text-xs font-semibold text-[#55534d]">
                    {imageCost("high")}
                  </span>
                </button>
              </div>
            </div>

            {/* Modele */}
            <details className="rounded-xl border border-[#e8e6df] p-3">
              <summary className="cursor-pointer select-none text-sm font-bold text-[#1A1A1A]">
                Modele AI
              </summary>
              <div className="mt-3 flex flex-col gap-3">
                <label className="flex flex-col gap-1 text-xs font-medium text-[#8a887f]">
                  Model graficzny
                  <select
                    value={prefs.provider}
                    onChange={(e) =>
                      setPrefs((p) => ({ ...p, provider: e.target.value as ProviderName }))
                    }
                    className="rounded-xl border border-[#dcd9d1] px-2 py-2 text-sm text-[#1A1A1A] outline-none focus:border-[#b9a646]"
                  >
                    <option value="flux">FLUX Kontext (fal.ai) — edycja + inpainting</option>
                    <option value="gemini">Nano Banana Pro (Google)</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs font-medium text-[#8a887f]">
                  Model językowy (tłumaczenie poleceń)
                  <select
                    value={prefs.claudeModel}
                    onChange={(e) => setPrefs((p) => ({ ...p, claudeModel: e.target.value }))}
                    className="rounded-xl border border-[#dcd9d1] px-2 py-2 text-sm text-[#1A1A1A] outline-none focus:border-[#b9a646]"
                  >
                    {CLAUDE_MODELS.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </details>

            <button
              type="button"
              disabled={busy !== null || !canSubmit}
              onClick={handleSend}
              className="rounded-xl bg-[#50344f] py-3 font-semibold text-white shadow-sm transition-colors hover:bg-[#684366] disabled:opacity-40"
            >
              {busy === "edit" ? "Generowanie…" : "✨ Generuj wizualizację"}
            </button>

            {error && (
              <p className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-600">
                {error}
              </p>
            )}
          </div>
        </aside>
      </div>
    </main>
  );
}
