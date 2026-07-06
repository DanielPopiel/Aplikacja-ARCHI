"use client";

import type { HistoryNode, Project } from "@/lib/types";

interface Props {
  project: Project;
  onSelect: (nodeId: string) => void;
  disabled?: boolean;
}

/**
 * History as a tree: every edit is a node, branches happen when the user
 * goes back to an earlier version and continues from there.
 */
export default function HistoryTree({ project, onSelect, disabled }: Props) {
  const childrenOf = new Map<string | null, HistoryNode[]>();
  for (const node of project.nodes) {
    const list = childrenOf.get(node.parentId) ?? [];
    list.push(node);
    childrenOf.set(node.parentId, list);
  }
  for (const list of childrenOf.values()) {
    list.sort((a, b) => a.createdAt - b.createdAt);
  }

  const renderNode = (node: HistoryNode, depth: number): React.ReactNode => {
    const isCurrent = node.id === project.currentNodeId;
    const children = childrenOf.get(node.id) ?? [];
    const label = node.instructionPl === null ? "Oryginał" : node.summaryPl || node.instructionPl;

    return (
      <div key={node.id} style={{ marginLeft: depth > 0 ? 14 : 0 }}>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onSelect(node.id)}
          className={`w-full text-left flex items-center gap-2 rounded-lg border p-2 mb-1.5 transition-colors ${
            isCurrent
              ? "border-emerald-500 bg-emerald-500/10"
              : "border-neutral-700 bg-neutral-800/60 hover:border-neutral-500"
          } ${disabled ? "opacity-60" : "cursor-pointer"}`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={node.imageUrl}
            alt=""
            className="h-12 w-12 shrink-0 rounded object-cover bg-neutral-900"
            loading="lazy"
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-neutral-100">{label}</p>
            <p className="text-xs text-neutral-400">
              {new Date(node.createdAt).toLocaleTimeString("pl-PL", {
                hour: "2-digit",
                minute: "2-digit",
              })}
              {typeof node.costUsd === "number" && node.costUsd > 0 && (
                <> · ${node.costUsd.toFixed(3)}</>
              )}
              {node.provider && <> · {node.provider === "flux" ? "FLUX" : "Nano Banana"}</>}
              {isCurrent && <span className="text-emerald-400"> · aktualna</span>}
            </p>
          </div>
        </button>
        {children.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };

  const roots = childrenOf.get(null) ?? [];
  return <div>{roots.map((root) => renderNode(root, 0))}</div>;
}
