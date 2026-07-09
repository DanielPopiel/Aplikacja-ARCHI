"use client";

import type { Budgets, Project } from "@/lib/types";

interface Props {
  projects: Project[];
  budgets: Budgets | null;
  onBudgetsChange: (budgets: Budgets) => void;
  onClose: () => void;
}

export interface UsageStats {
  anthropicUsd: number;
  falUsd: number;
  googleUsd: number;
  tokensIn: number;
  tokensOut: number;
  totalUsd: number;
}

/** App-tracked spend since the 1st of the current month, split per provider. */
export function computeMonthUsage(projects: Project[]): UsageStats {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const stats: UsageStats = {
    anthropicUsd: 0,
    falUsd: 0,
    googleUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
    totalUsd: 0,
  };
  for (const project of projects) {
    for (const node of project.nodes) {
      if (node.createdAt < monthStart || !node.costUsd) continue;
      stats.totalUsd += node.costUsd;
      stats.tokensIn += node.tokensIn ?? 0;
      stats.tokensOut += node.tokensOut ?? 0;
      if (typeof node.costClaudeUsd === "number") {
        stats.anthropicUsd += node.costClaudeUsd;
        const image = node.costImageUsd ?? node.costUsd - node.costClaudeUsd;
        if (node.provider === "gemini") stats.googleUsd += image;
        else stats.falUsd += image;
      } else {
        // Legacy node without split — attribute everything to the image provider.
        if (node.provider === "gemini") stats.googleUsd += node.costUsd;
        else stats.falUsd += node.costUsd;
      }
    }
  }
  return stats;
}

const EMPTY_BUDGETS: Budgets = { anthropic: null, fal: null, google: null, updatedAt: 0 };

interface RowSpec {
  key: "anthropic" | "fal" | "google";
  label: string;
  detail: string;
  spent: number;
}

export default function UsagePanel({ projects, budgets, onBudgetsChange, onClose }: Props) {
  const usage = computeMonthUsage(projects);
  const b = budgets ?? EMPTY_BUDGETS;

  const rows: RowSpec[] = [
    {
      key: "anthropic",
      label: "Anthropic (Claude)",
      detail: `${usage.tokensIn.toLocaleString("pl-PL")} tok. wejścia · ${usage.tokensOut.toLocaleString("pl-PL")} tok. wyjścia`,
      spent: usage.anthropicUsd,
    },
    { key: "fal", label: "fal.ai (FLUX)", detail: "generacje obrazów", spent: usage.falUsd },
    {
      key: "google",
      label: "Google (Nano Banana)",
      detail: "generacje obrazów",
      spent: usage.googleUsd,
    },
  ];

  // Which limit constrains the most = the lowest remaining fraction of budget.
  const fractions = rows.map((row) => {
    const budget = b[row.key];
    return budget && budget > 0 ? Math.max(0, (budget - row.spent) / budget) : null;
  });
  const definedFractions = fractions.filter((f): f is number => f !== null);
  const tightestIdx =
    definedFractions.length > 0
      ? fractions.indexOf(Math.min(...definedFractions))
      : -1;

  function setBudget(key: RowSpec["key"], raw: string) {
    const value = raw === "" ? null : Math.max(0, Number(raw));
    onBudgetsChange({
      ...b,
      [key]: value === null || Number.isNaN(value) ? null : value,
      updatedAt: Date.now(),
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#1A1A1A]/30 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-lg font-bold text-[#1A1A1A]">📊 Zużycie i budżety</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-[#8a887f] hover:text-[#1A1A1A]"
          >
            ✕
          </button>
        </div>
        <p className="mb-4 text-xs text-[#8a887f]">
          Wydatki od 1. dnia bieżącego miesiąca, liczone z historii edycji w aplikacji.
          Sald kont nie da się pobrać przez API — wpisz miesięczny budżet (lub aktualne
          saldo), a aplikacja pokaże, ile zostało i który limit kończy się pierwszy.
        </p>

        <div className="mb-4 rounded-xl bg-[#F4F4F2] p-3 text-sm font-semibold text-[#1A1A1A]">
          Razem w tym miesiącu: ${usage.totalUsd.toFixed(2)}
        </div>

        <div className="flex flex-col gap-3">
          {rows.map((row, i) => {
            const budget = b[row.key];
            const remaining = budget !== null ? budget - row.spent : null;
            const pct =
              budget && budget > 0 ? Math.min(100, (row.spent / budget) * 100) : 0;
            const tightest = i === tightestIdx && budget !== null;
            const exhausted = remaining !== null && remaining <= 0;
            return (
              <div
                key={row.key}
                className={`rounded-xl border p-3 ${
                  tightest ? "border-[#b9a646] bg-[#f6f2e3]/70" : "border-[#e8e6df]"
                }`}
              >
                <div className="mb-1 flex items-baseline justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-[#1A1A1A]">
                      {row.label}
                      {tightest && (
                        <span className="ml-2 rounded-full bg-[#50344f] px-2 py-0.5 text-[10px] font-bold text-white">
                          NAJBLIŻEJ LIMITU
                        </span>
                      )}
                    </p>
                    <p className="text-[11px] text-[#a5a29a]">{row.detail}</p>
                  </div>
                  <p className="shrink-0 text-sm font-semibold text-[#1A1A1A]">
                    ${row.spent.toFixed(2)}
                    {budget !== null && (
                      <span className="text-[#8a887f]"> / ${budget.toFixed(2)}</span>
                    )}
                  </p>
                </div>
                {budget !== null && (
                  <>
                    <div className="mb-1 h-2 overflow-hidden rounded-full bg-[#edebe4]">
                      <div
                        className={`h-full rounded-full ${
                          exhausted ? "bg-red-500" : pct > 75 ? "bg-[#50344f]" : "bg-emerald-500"
                        }`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <p className={`text-xs ${exhausted ? "font-semibold text-red-500" : "text-[#8a887f]"}`}>
                      {exhausted
                        ? "Budżet wyczerpany"
                        : `Zostało $${remaining!.toFixed(2)} (${Math.round((remaining! / budget) * 100)}%)`}
                    </p>
                  </>
                )}
                <label className="mt-2 flex items-center gap-2 text-xs text-[#8a887f]">
                  Budżet / saldo (USD):
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={budget ?? ""}
                    placeholder="np. 20"
                    onChange={(e) => setBudget(row.key, e.target.value)}
                    className="w-24 rounded-lg border border-[#dcd9d1] px-2 py-1 text-sm text-[#1A1A1A] outline-none focus:border-[#b9a646]"
                  />
                </label>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
