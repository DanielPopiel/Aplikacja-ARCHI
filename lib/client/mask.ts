"use client";

import type { EditArea } from "../types";

function getImageSize(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error("Nie udało się wczytać obrazu do budowy maski."));
    img.src = url;
  });
}

/**
 * Build an inpainting mask (white = regenerate, black = keep) matching the
 * image's natural size. Rectangles get a small padding so the inpainting
 * model can blend edges with the surroundings.
 */
export async function buildMaskBlob(imageUrl: string, areas: EditArea[]): Promise<Blob> {
  const { width, height } = await getImageSize(imageUrl);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas niedostępny w tej przeglądarce.");

  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, width, height);

  // Generous padding: the mask must also cover glow/shadows the edited object
  // casts on its surroundings, or the inpainting model recreates it to match.
  const pad = Math.round(Math.max(width, height) * 0.03);
  ctx.fillStyle = "#ffffff";
  for (const area of areas) {
    const x = Math.max(0, Math.round(area.x * width) - pad);
    const y = Math.max(0, Math.round(area.y * height) - pad);
    const w = Math.min(width - x, Math.round(area.w * width) + pad * 2);
    const h = Math.min(height - y, Math.round(area.h * height) + pad * 2);
    ctx.fillRect(x, y, w, h);
  }

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Nie udało się wygenerować maski.");
  return blob;
}
