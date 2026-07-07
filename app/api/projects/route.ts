import { NextRequest, NextResponse } from "next/server";
import { list, put } from "@vercel/blob";
import type { ProjectsDocument } from "@/lib/types";

export const maxDuration = 60;

const DOC_PATH = "archi/projects.json";

/**
 * Cross-device memory for visualisations: the whole project index is stored
 * as a single JSON blob (one user → last write wins, tombstones for deletes).
 * Without a Blob token the client just keeps using localStorage.
 */
export async function GET() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json({ synced: false, projects: [], deletedIds: [] });
  }
  try {
    const { blobs } = await list({ prefix: DOC_PATH, limit: 1 });
    if (blobs.length === 0) {
      return NextResponse.json({ synced: true, projects: [], deletedIds: [] });
    }
    // Cache-buster: public blob URLs sit behind a CDN with ~60s cache.
    const res = await fetch(`${blobs[0].url}?ts=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`Blob fetch ${res.status}`);
    const doc = (await res.json()) as ProjectsDocument;
    return NextResponse.json({
      synced: true,
      projects: Array.isArray(doc.projects) ? doc.projects : [],
      deletedIds: Array.isArray(doc.deletedIds) ? doc.deletedIds : [],
      budgets: doc.budgets ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Nieznany błąd";
    return NextResponse.json({ error: `Odczyt historii nie powiódł się: ${message}` }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json({ synced: false });
  }
  try {
    const doc = (await request.json()) as ProjectsDocument;
    if (!Array.isArray(doc.projects)) {
      return NextResponse.json({ error: "Nieprawidłowy format" }, { status: 400 });
    }
    await put(
      DOC_PATH,
      JSON.stringify({
        projects: doc.projects,
        deletedIds: doc.deletedIds ?? [],
        budgets: doc.budgets ?? null,
      }),
      {
        access: "public",
        contentType: "application/json",
        addRandomSuffix: false,
        allowOverwrite: true,
      },
    );
    return NextResponse.json({ synced: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Nieznany błąd";
    return NextResponse.json({ error: `Zapis historii nie powiódł się: ${message}` }, { status: 500 });
  }
}
