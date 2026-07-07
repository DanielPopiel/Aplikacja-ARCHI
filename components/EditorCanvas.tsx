"use client";

import { useRef, useState } from "react";
import type { EditArea } from "@/lib/types";

interface DraftRect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface Props {
  imageUrl: string;
  areas: EditArea[];
  drawMode: boolean;
  onAddArea: (area: Omit<EditArea, "description">) => void;
  onRemoveArea: (index: number) => void;
}

const MIN_SIZE = 0.02; // ignore accidental clicks (2% of the image)

/** Image with rectangular area selection drawn directly on top of it. */
export default function EditorCanvas({ imageUrl, areas, drawMode, onAddArea, onRemoveArea }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<DraftRect | null>(null);

  function toNormalized(clientX: number, clientY: number) {
    const rect = containerRef.current!.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)),
    };
  }

  return (
    <div
      ref={containerRef}
      className={`relative select-none overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-[#E8E8F0] ${
        drawMode ? "cursor-crosshair touch-none" : ""
      }`}
      onPointerDown={(e) => {
        if (!drawMode) return;
        e.preventDefault();
        try {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        } catch {
          /* pointer already released — drawing still works via move/up */
        }
        const p = toNormalized(e.clientX, e.clientY);
        setDraft({ x1: p.x, y1: p.y, x2: p.x, y2: p.y });
      }}
      onPointerMove={(e) => {
        if (!drawMode || !draft) return;
        const p = toNormalized(e.clientX, e.clientY);
        setDraft({ ...draft, x2: p.x, y2: p.y });
      }}
      onPointerUp={(e) => {
        if (!drawMode || !draft) return;
        // Close the rectangle at the pointer-up position itself — the last
        // pointermove may not have committed yet on fast gestures.
        const p = toNormalized(e.clientX, e.clientY);
        const x = Math.min(draft.x1, p.x);
        const y = Math.min(draft.y1, p.y);
        const w = Math.abs(p.x - draft.x1);
        const h = Math.abs(p.y - draft.y1);
        setDraft(null);
        if (w >= MIN_SIZE && h >= MIN_SIZE) {
          onAddArea({ x, y, w, h });
        }
      }}
      onPointerCancel={() => setDraft(null)}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={imageUrl}
        alt="Aktualna wersja wnętrza"
        className="block w-full h-auto"
        draggable={false}
      />

      {areas.map((area, i) => (
        <div
          key={i}
          className="absolute rounded-md border-2 border-orange-500 bg-orange-400/15"
          style={{
            left: `${area.x * 100}%`,
            top: `${area.y * 100}%`,
            width: `${area.w * 100}%`,
            height: `${area.h * 100}%`,
          }}
        >
          <span className="absolute -left-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full bg-orange-500 text-[11px] font-bold text-white shadow">
            {i + 1}
          </span>
          <button
            type="button"
            title="Usuń zaznaczenie"
            onClick={(e) => {
              e.stopPropagation();
              onRemoveArea(i);
            }}
            className="absolute -right-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full bg-white text-[11px] font-bold text-neutral-500 shadow ring-1 ring-neutral-200 hover:text-red-500"
          >
            ×
          </button>
        </div>
      ))}

      {draft && (
        <div
          className="absolute rounded-md border-2 border-dashed border-orange-500 bg-orange-400/10"
          style={{
            left: `${Math.min(draft.x1, draft.x2) * 100}%`,
            top: `${Math.min(draft.y1, draft.y2) * 100}%`,
            width: `${Math.abs(draft.x2 - draft.x1) * 100}%`,
            height: `${Math.abs(draft.y2 - draft.y1) * 100}%`,
          }}
        />
      )}

      {drawMode && !draft && (
        <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center">
          <span className="rounded-full bg-[#26275F]/90 px-3 py-1 text-xs text-white shadow">
            Narysuj prostokąt na obszarze do zmiany
          </span>
        </div>
      )}
    </div>
  );
}
