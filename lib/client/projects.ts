"use client";

import type { HistoryNode, Project, ProjectsDocument } from "../types";

const STORAGE_KEY = "archi.projects.v1";
const DELETED_KEY = "archi.deleted.v1";

function normalize(project: Project): Project {
  return { ...project, updatedAt: project.updatedAt ?? project.createdAt };
}

export function loadProjects(): Project[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Project[]).map(normalize) : [];
  } catch {
    return [];
  }
}

export function saveProjects(projects: Project[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
  } catch (err) {
    console.error("Nie udało się zapisać projektów w localStorage:", err);
  }
}

export function loadDeletedIds(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(DELETED_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveDeletedIds(ids: string[]): void {
  try {
    window.localStorage.setItem(DELETED_KEY, JSON.stringify(ids.slice(-200)));
  } catch {
    /* ignore */
  }
}

/** Merge local and remote documents: tombstones win, newer project wins. */
export function mergeDocuments(
  local: ProjectsDocument,
  remote: ProjectsDocument,
): ProjectsDocument {
  const deletedIds = Array.from(new Set([...local.deletedIds, ...remote.deletedIds]));
  const deleted = new Set(deletedIds);
  const byId = new Map<string, Project>();
  for (const p of [...remote.projects, ...local.projects]) {
    if (deleted.has(p.id)) continue;
    const existing = byId.get(p.id);
    const candidate = normalize(p);
    if (!existing || candidate.updatedAt >= existing.updatedAt) {
      byId.set(p.id, candidate);
    }
  }
  const projects = Array.from(byId.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  return { projects, deletedIds };
}

export function createProject(name: string, rootImageUrl: string): Project {
  const rootNode: HistoryNode = {
    id: crypto.randomUUID(),
    parentId: null,
    imageUrl: rootImageUrl,
    instructionPl: null,
    createdAt: Date.now(),
  };
  return {
    id: crypto.randomUUID(),
    name,
    nodes: [rootNode],
    currentNodeId: rootNode.id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export function projectCost(project: Project): number {
  return project.nodes.reduce((sum, n) => sum + (n.costUsd ?? 0), 0);
}

export function rootNode(project: Project): HistoryNode {
  return project.nodes.find((n) => n.parentId === null) ?? project.nodes[0];
}

export function nodeById(project: Project, id: string): HistoryNode | undefined {
  return project.nodes.find((n) => n.id === id);
}

/** Summaries along the path root → node (for Claude's session context). */
export function chainSummaries(project: Project, nodeId: string): string[] {
  const byId = new Map(project.nodes.map((n) => [n.id, n]));
  const summaries: string[] = [];
  let cur = byId.get(nodeId);
  while (cur) {
    if (cur.summaryPl) summaries.unshift(cur.summaryPl);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return summaries;
}
