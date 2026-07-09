"use client";

import { useCallback, useRef, useState } from "react";

interface Props {
  beforeUrl: string;
  afterUrl: string;
}

/** Comparison slider: "before" is clipped from the right at the handle position. */
export default function BeforeAfterSlider({ beforeUrl, afterUrl }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(50);
  const draggingRef = useRef(false);

  const updateFromClientX = useCallback((clientX: number) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pct = ((clientX - rect.left) / rect.width) * 100;
    setPosition(Math.min(100, Math.max(0, pct)));
  }, []);

  return (
    <div
      ref={containerRef}
      className="relative select-none overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-[#e8e6df] touch-none"
      onPointerDown={(e) => {
        draggingRef.current = true;
        try {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        } catch {
          /* ignore — dragging still works via move/up */
        }
        updateFromClientX(e.clientX);
      }}
      onPointerMove={(e) => {
        if (draggingRef.current) updateFromClientX(e.clientX);
      }}
      onPointerUp={() => {
        draggingRef.current = false;
      }}
      onPointerCancel={() => {
        draggingRef.current = false;
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={afterUrl} alt="Po edycji" className="block w-full h-auto" draggable={false} />
      <div
        className="absolute inset-0"
        style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={beforeUrl}
          alt="Przed edycją"
          className="block w-full h-full object-cover"
          draggable={false}
        />
      </div>
      <div
        className="absolute top-0 bottom-0 w-0.5 bg-white shadow-[0_0_8px_rgba(0,0,0,0.6)]"
        style={{ left: `${position}%` }}
      >
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-8 w-8 rounded-full bg-white shadow flex items-center justify-center text-neutral-700 text-xs font-bold">
          ⇄
        </div>
      </div>
      <span className="absolute top-2 left-2 rounded bg-black/60 px-2 py-0.5 text-xs text-white">
        PRZED
      </span>
      <span className="absolute top-2 right-2 rounded bg-black/60 px-2 py-0.5 text-xs text-white">
        PO
      </span>
    </div>
  );
}
