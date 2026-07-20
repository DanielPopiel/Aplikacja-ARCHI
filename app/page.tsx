"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Budgets,
  CameraAngle,
  EditArea,
  EditResponseBody,
  HistoryNode,
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

/**
 * Fixed benchmark suite: 6 generic, image-agnostic edits covering the core
 * playbook categories (removal, material, color, lighting, adding, style).
 * Run on "standard" quality to keep a full pass cheap (~$0.25-0.30). Every
 * run branches off the SAME current node so results are directly
 * comparable, and each node records which Claude model produced it.
 */
const TEST_SUITE: Array<{ label: string; instruction: string }> = [
  {
    label: "🧪 Usuwanie bałaganu",
    instruction:
      "Usuń z widoku wszelkie kable, przewody i drobny bałagan (np. przedmioty leżące na blacie lub podłodze). Jeśli nic takiego nie ma, zostaw obraz bez zmian.",
  },
  { label: "🧪 Podłoga → jasny dąb", instruction: "Zmień podłogę na jasny dąb w macie." },
  { label: "🧪 Ściany na biało", instruction: "Pomaluj ściany na ciepłą biel." },
  {
    label: "🧪 Złota godzina",
    instruction: "Zmień porę dnia na złotą godzinę, ciepłe wieczorne światło.",
  },
  {
    label: "🧪 Dodaj roślinę",
    instruction: "Dodaj niewielką roślinę doniczkową w wolnym rogu pomieszczenia.",
  },
  {
    label: "🧪 Styl minimalistyczny",
    instruction: "Nadaj wnętrzu bardziej minimalistyczny styl, zachowując układ pomieszczenia.",
  },
];

interface SubmitEditParams {
  imageUrl: string;
  instruction: string;
  claudeModel: string;
  quality: Quality;
  provider: ProviderName;
  cameraAngle?: CameraAngle | null;
  areas?: EditArea[];
  maskUrl?: string;
  referenceObjects?: ReferenceObject[];
  historySummaries: string[];
}

/**
 * Shared POST /api/edit call, used by the single-edit, test-suite and
 * model-comparison flows alike so the request shape can't drift between
 * them (a past bug was fixed in only one of two duplicated call sites).
 */
async function submitEdit(params: SubmitEditParams): Promise<EditResponseBody> {
  const res = await fetch("/api/edit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const data: EditResponseBody & { error?: string } = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Błąd ${res.status}`);
  return data;
}

/** Turns an /api/edit response into a new history node. */
function buildHistoryNode(opts: {
  parentId: string;
  data: EditResponseBody;
  instructionPl: string;
  testLabel?: string;
}): HistoryNode {
  return {
    id: crypto.randomUUID(),
    parentId: opts.parentId,
    imageUrl: opts.data.imageUrl,
    instructionPl: opts.instructionPl,
    testLabel: opts.testLabel,
    promptEn: opts.data.promptEn,
    summaryPl: opts.data.summaryPl,
    provider: opts.data.provider,
    quality: opts.data.quality,
    costUsd: opts.data.costUsd.total,
    costClaudeUsd: opts.data.costUsd.claude,
    costImageUsd: opts.data.costUsd.image,
    tokensIn: opts.data.claudeTokens?.input,
    tokensOut: opts.data.claudeTokens?.output,
    claudeModel: opts.data.claudeModel,
    createdAt: Date.now(),
  };
}

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
  const [testProgress, setTestProgress] = useState<{
    index: number;
    total: number;
    label: string;
  } | null>(null);
  const [compareModels, setCompareModels] = useState<string[]>(
    CLAUDE_MODELS.map((m) => m.value),
  );
  const [compareProgress, setCompareProgress] = useState<{
    index: number;
    total: number;
    label: string;
  } | null>(null);

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

  // FLUX can only use reference photos reliably through the mask path —
  // without a marked area the maskless multi-image model leaks the
  // reference's framing into the result. Block that combination up front.
  const fluxRefsNeedArea =
    prefs.provider === "flux" && referenceObjects.length > 0 && areas.length === 0;

  const canSubmit =
    !fluxRefsNeedArea &&
    (instruction.trim().length > 0 ||
      areas.some((a) => a.description.trim()) ||
      referenceObjects.length > 0 ||
      cameraAngle !== null);

  async function handleSend() {
    if (!canSubmit || !active || !current || busy) return;
    setBusy("edit");
    setError(null);
    setDrawMode(false);
    const projectId = active.id;
    const parentId = current.id;
    try {
      // Any marked area builds a mask — the server refines it with SAM,
      // edits just that region, and mechanically restores everything outside
      // it. This applies to every image model now, not only FLUX.
      let maskUrl: string | undefined;
      if (areas.length > 0) {
        const maskBlob = await buildMaskBlob(current.imageUrl, areas);
        maskUrl = await uploadBlob(maskBlob, "mask.png");
      }

      const data = await submitEdit({
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
      });

      const node = buildHistoryNode({
        parentId,
        data,
        instructionPl:
          instruction.trim() ||
          areas
            .map((a) => a.description.trim())
            .filter(Boolean)
            .join("; ") ||
          "Zmiana kadru",
      });
      updateProject(projectId, (p) => ({
        ...p,
        nodes: [...p.nodes, node],
        currentNodeId: node.id,
      }));
      setInstruction("");
      if (data.warning) setError(`⚠️ ${data.warning}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Edycja nie powiodła się");
    } finally {
      setBusy(null);
    }
  }

  /**
   * Fires the fixed TEST_SUITE against the current image, all branching off
   * the same baseline node so runs stay comparable. Meant to be re-run after
   * a playbook/model change to see whether known failure modes come back —
   * rate results with 👍👎 and compare the "· <Model>" tag per node.
   *
   * Runs all 6 IN PARALLEL — a sequential chain kept the batch exposed to a
   * page-level interruption (reload, another session's hot-reload) for up
   * to ~2 minutes; if that happened mid-chain the remaining tests silently
   * never ran. Parallel cuts that window to one request's duration.
   */
  async function runTestSuite() {
    if (!active || !current || busy || testProgress) return;
    const projectId = active.id;
    const baseNode = current;
    const historySummariesSnapshot = chainSummaries(active, baseNode.id);
    setBusy("edit");
    setError(null);

    let completed = 0;
    const results = await Promise.allSettled(
      TEST_SUITE.map(async (testCase) => {
        const data = await submitEdit({
          imageUrl: baseNode.imageUrl,
          instruction: testCase.instruction,
          provider: prefs.provider,
          quality: "standard",
          claudeModel: prefs.claudeModel,
          historySummaries: historySummariesSnapshot,
        });
        const node = buildHistoryNode({
          parentId: baseNode.id,
          data,
          instructionPl: testCase.instruction,
          testLabel: testCase.label,
        });
        updateProject(projectId, (p) => ({ ...p, nodes: [...p.nodes, node] }));
        completed += 1;
        setTestProgress({ index: completed, total: TEST_SUITE.length, label: testCase.label });
        return testCase.label;
      }),
    );

    const failures = results
      .map((r, i) =>
        r.status === "rejected"
          ? {
              label: TEST_SUITE[i].label,
              reason: r.reason instanceof Error ? r.reason.message : String(r.reason),
            }
          : null,
      )
      .filter((x): x is { label: string; reason: string } => x !== null);
    failures.forEach((f) => {
      console.error(`Test suite: "${f.label}" failed:`, f.reason);
    });

    setTestProgress(null);
    setBusy(null);
    if (failures.length > 0) {
      const reasons = [...new Set(failures.map((f) => f.reason))];
      setError(
        `${failures.length}/${TEST_SUITE.length} testów nie powiodło się. Powód: ${reasons.join(" | ")}. Pozostałe wyniki są w historii.`,
      );
    }
  }

  function toggleCompareModel(value: string) {
    setCompareModels((prev) =>
      prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value],
    );
  }

  /**
   * Runs the CURRENT instruction (+ areas/refs/camera) once per selected
   * Claude model, all branching off the current node so results sit side by
   * side in the history tree — the requested "porównaj na kilku modelach
   * naraz" feature. The mask (if any) is model-independent, so it's built
   * once and reused across variants rather than rebuilt per model.
   *
   * Fires all variants IN PARALLEL (Promise.allSettled), not one after
   * another: a sequential chain of 3 x ~20s requests spends a full minute
   * exposed to any page-level interruption (reload, another dev session's
   * hot-reload touching this same project) — if that happens mid-chain, the
   * async function's closure is torn down and the remaining variants never
   * run, with nothing left to show an error for. Parallel cuts that window
   * to ~20s and is also just faster.
   */
  async function runModelComparison() {
    if (!canSubmit || !active || !current || busy || compareModels.length < 2) return;
    setBusy("edit");
    setError(null);
    setDrawMode(false);
    const projectId = active.id;
    const parentId = current.id;
    const baseImageUrl = current.imageUrl;
    const historySummariesSnapshot = chainSummaries(active, current.id);
    const instructionText =
      instruction.trim() ||
      areas
        .map((a) => a.description.trim())
        .filter(Boolean)
        .join("; ") ||
      "Zmiana kadru";
    const total = compareModels.length;

    try {
      let maskUrl: string | undefined;
      if (areas.length > 0) {
        const maskBlob = await buildMaskBlob(baseImageUrl, areas);
        maskUrl = await uploadBlob(maskBlob, "mask.png");
      }

      let completed = 0;
      const results = await Promise.allSettled(
        compareModels.map(async (model) => {
          const modelLabel = CLAUDE_MODELS.find((m) => m.value === model)?.label ?? model;
          const data = await submitEdit({
            imageUrl: baseImageUrl,
            instruction: instruction.trim(),
            provider: prefs.provider,
            quality: prefs.quality,
            claudeModel: model,
            cameraAngle,
            areas,
            maskUrl,
            referenceObjects,
            historySummaries: historySummariesSnapshot,
          });
          const node = buildHistoryNode({ parentId, data, instructionPl: instructionText });
          updateProject(projectId, (p) => ({ ...p, nodes: [...p.nodes, node] }));
          completed += 1;
          setCompareProgress({ index: completed, total, label: modelLabel });
          return modelLabel;
        }),
      );

      const failures = results
        .map((r, i) =>
          r.status === "rejected"
            ? {
                label: CLAUDE_MODELS.find((m) => m.value === compareModels[i])?.label ?? compareModels[i],
                reason: r.reason instanceof Error ? r.reason.message : String(r.reason),
              }
            : null,
        )
        .filter((x): x is { label: string; reason: string } => x !== null);
      failures.forEach((f) => {
        console.error(`Porównanie modeli: "${f.label}" nie powiodło się:`, f.reason);
      });

      setInstruction("");
      if (failures.length > 0) {
        // Surface the ACTUAL server reason(s), not just model names — a bare
        // "N/M failed" hides whether it's our bug, a refusal, or out-of-credits.
        const reasons = [...new Set(failures.map((f) => f.reason))];
        setError(
          `${failures.length}/${total} wariantów nie powiodło się. Powód: ${reasons.join(" | ")}`,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Porównanie nie powiodło się");
    } finally {
      setCompareProgress(null);
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

  // Estimated per-image cost (USD) for the selected provider/quality. Marked
  // edits add ~$0.005 for SAM object segmentation (negligible, omitted here).
  const imageUnitCost = (q: Quality): number => {
    switch (prefs.provider) {
      case "gemini":
        return q === "high" ? 0.24 : 0.14;
      case "seedream":
        return 0.035;
      case "nano-banana-2":
        return q === "high" ? 0.16 : 0.08;
      default: // flux
        return q === "high" ? 0.08 : 0.04;
    }
  };

  const imageCost = (q: Quality): string => `≈$${imageUnitCost(q).toFixed(2)}`;

  // Rough per-variant estimate for the model-comparison button: image cost
  // plus a ballpark Claude translation cost (~$0.005-0.03 depending on
  // model/effort — not worth per-model precision for a pre-run estimate).
  const compareCostEstimate = (): number =>
    (imageUnitCost(prefs.quality) + 0.015) * compareModels.length;

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
                onSelect={(nodeId) => {
                  updateProject(active.id, (p) => ({ ...p, currentNodeId: nodeId }));
                  // Recall the instruction typed FROM this version (its latest
                  // child edit) so the user can tweak and retry — but never
                  // overwrite text they are currently composing.
                  if (!instruction.trim()) {
                    const children = active.nodes
                      .filter((n) => n.parentId === nodeId)
                      .sort((a, b) => b.createdAt - a.createdAt);
                    const recalled =
                      children[0]?.instructionPl ??
                      nodeById(active, nodeId)?.instructionPl ??
                      "";
                    if (recalled) setInstruction(recalled.slice(0, MAX_INSTRUCTION));
                  }
                }}
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
                  {testProgress ? (
                    <>
                      <p className="text-sm font-medium text-[#1A1A1A]">
                        Test {testProgress.index}/{testProgress.total}: {testProgress.label}
                      </p>
                      <p className="text-xs text-[#8a887f]">Wyniki pojawiają się w historii na bieżąco</p>
                    </>
                  ) : compareProgress ? (
                    <>
                      <p className="text-sm font-medium text-[#1A1A1A]">
                        Wariant {compareProgress.index}/{compareProgress.total}:{" "}
                        {compareProgress.label}
                      </p>
                      <p className="text-xs text-[#8a887f]">Wyniki pojawiają się w historii na bieżąco</p>
                    </>
                  ) : (
                    <>
                      <p className="text-sm font-medium text-[#1A1A1A]">Generowanie edycji…</p>
                      <p className="text-xs text-[#8a887f]">
                        Claude tłumaczy polecenie, potem model graficzny pracuje
                      </p>
                    </>
                  )}
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

            {/* Zaznacz obszar */}
            <div>
              {sectionLabel("Zaznacz obszar", true)}
              <p className="mb-2 text-xs text-[#8a887f]">
                Otocz obiekt prostokątem (z niewielkim zapasem) i opisz zmianę. Aplikacja
                sama wykryje dokładny kształt obiektu w środku (SAM) i zmieni tylko jego —
                reszta zdjęcia zostaje nietknięta.
                {areas.length > 0 && (
                  <span className="text-[#50344f]">
                    {" "}
                    Zmiany obejmą tylko zaznaczony obiekt.
                    {referenceObjects.length > 0 &&
                      " Obiekt referencyjny posłuży tylko do opisu wyglądu — jego zdjęcie nie trafia bezpośrednio do modelu graficznego w tym trybie."}
                  </span>
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
              {fluxRefsNeedArea && (
                <p className="mb-2 rounded-xl border border-amber-300 bg-amber-50 p-2.5 text-xs font-medium text-amber-800">
                  ⚠️ Przy modelu FLUX zaznacz obszar, w którym ma pojawić się obiekt
                  referencyjny — edycja przejdzie wtedy przez maskę i reszta zdjęcia
                  będzie gwarantowanie nietknięta. Bez obszaru generowanie jest
                  zablokowane (możesz też przełączyć model na Nano Banana Pro).
                </p>
              )}
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

            {/* Modele AI — zawsze widoczne, nad Jakością */}
            <div className="rounded-xl border border-[#e8e6df] p-3">
              <h3 className="mb-3 text-sm font-bold text-[#1A1A1A]">Modele AI</h3>
              <div className="flex flex-col gap-3">
                <label className="flex flex-col gap-1 text-xs font-medium text-[#8a887f]">
                  Model graficzny
                  <select
                    value={prefs.provider}
                    onChange={(e) =>
                      setPrefs((p) => ({ ...p, provider: e.target.value as ProviderName }))
                    }
                    className="rounded-xl border border-[#dcd9d1] px-2 py-2 text-sm text-[#1A1A1A] outline-none focus:border-[#b9a646]"
                  >
                    <option value="flux">FLUX Kontext (fal.ai) — sprawdzony</option>
                    <option value="nano-banana-2">Nano Banana 2 (Google) — najlepszy do wnętrz</option>
                    <option value="seedream">Seedream 5 Lite — tani i szybki (test)</option>
                    <option value="gemini">Nano Banana Pro (Google AI Studio)</option>
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
                      Szybki, tani podgląd w mniejszym rozmiarze
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
                      Wersja finalna — rozmiar 1:1 jak edytowany obraz
                    </span>
                  </span>
                  <span className="shrink-0 rounded-full bg-[#efede7] px-2 py-0.5 text-xs font-semibold text-[#55534d]">
                    {imageCost("high")}
                  </span>
                </button>
              </div>
            </div>

            {/* Porównanie modeli na TYM poleceniu */}
            <details className="rounded-xl border border-[#e8e6df] p-3">
              <summary className="cursor-pointer select-none text-sm font-bold text-[#1A1A1A]">
                🔀 Porównaj modele
              </summary>
              <div className="mt-2 flex flex-col gap-2">
                <p className="text-xs text-[#8a887f]">
                  Wykona TO polecenie (z zaznaczeniami, referencjami i kątem kamery)
                  równolegle na zaznaczonych modelach Claude — każdy wynik trafia jako
                  osobna gałąź w historii, oznaczona modelem. Koszt mnoży się razy
                  liczba wybranych modeli.
                </p>
                <div className="flex flex-col gap-1.5">
                  {CLAUDE_MODELS.map((m) => (
                    <label
                      key={m.value}
                      className="flex items-center gap-2 text-sm text-[#1A1A1A]"
                    >
                      <input
                        type="checkbox"
                        checked={compareModels.includes(m.value)}
                        onChange={() => toggleCompareModel(m.value)}
                        disabled={busy !== null}
                        className="h-4 w-4 accent-[#50344f]"
                      />
                      {m.label}
                    </label>
                  ))}
                </div>
                <button
                  type="button"
                  disabled={busy !== null || !canSubmit || compareModels.length < 2}
                  onClick={runModelComparison}
                  className="rounded-xl border border-[#dcd9d1] py-2 text-sm font-semibold text-[#50344f] transition-colors hover:border-[#b9a646] disabled:opacity-40"
                >
                  {compareProgress
                    ? `Wariant ${compareProgress.index}/${compareProgress.total}: ${compareProgress.label}…`
                    : compareModels.length < 2
                      ? "Zaznacz min. 2 modele"
                      : `🔀 Porównaj (${compareModels.length} warianty, ≈$${compareCostEstimate().toFixed(2)})`}
                </button>
              </div>
            </details>

            {/* Zestaw testowy */}
            <details className="rounded-xl border border-[#e8e6df] p-3">
              <summary className="cursor-pointer select-none text-sm font-bold text-[#1A1A1A]">
                🧪 Zestaw testowy
              </summary>
              <div className="mt-2 flex flex-col gap-2">
                <p className="text-xs text-[#8a887f]">
                  Odpala {TEST_SUITE.length} stałych edycji (usuwanie, materiał, kolor,
                  światło, dodawanie, styl) na jakości „Szybka" — ok. $0.25–0.30 za cały
                  przebieg. Wyniki lądują jako gałęzie w historii, oznaczone modelem
                  Claude, którego użyto. Uruchom ponownie po zmianie playbooka albo
                  modelu, żeby porównać.
                </p>
                <button
                  type="button"
                  disabled={busy !== null || !current}
                  onClick={runTestSuite}
                  className="rounded-xl border border-[#dcd9d1] py-2 text-sm font-semibold text-[#50344f] transition-colors hover:border-[#b9a646] disabled:opacity-40"
                >
                  {testProgress
                    ? `Test ${testProgress.index}/${testProgress.total}…`
                    : `▶ Uruchom test (${TEST_SUITE.length} edycji)`}
                </button>
              </div>
            </details>

            {/* Kąt kamery — rzadko używane, na samym dole jako lista */}
            <div>
              {sectionLabel("Kąt kamery", true)}
              <select
                value={cameraAngle ?? ""}
                onChange={(e) =>
                  setCameraAngle((e.target.value || null) as CameraAngle | null)
                }
                disabled={busy !== null}
                className="w-full rounded-xl border border-[#dcd9d1] px-2 py-2 text-sm text-[#1A1A1A] outline-none focus:border-[#b9a646] disabled:opacity-60"
              >
                <option value="">Bez zmiany kadru</option>
                {CAMERA_ANGLES.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </select>
            </div>

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
