"use client";

import type { HistoryNode, Project } from "../types";

const STORAGE_KEY = "archi.projects.v1";

export function loadProjects(): Project[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Project[]) : [];
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
