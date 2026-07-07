export type ProviderName = "flux" | "gemini";
export type Quality = "standard" | "high";
export type CameraAngle = "low" | "high" | "left" | "right" | "detail" | "wide";

/** Rectangle marked on the image; coordinates normalized 0..1, origin top-left. */
export interface EditArea {
  x: number;
  y: number;
  w: number;
  h: number;
  description: string;
}

export interface EditRequestBody {
  imageUrl: string;
  instruction: string;
  provider?: ProviderName;
  quality?: Quality;
  claudeModel?: string;
  cameraAngle?: CameraAngle | null;
  areas?: EditArea[];
  /** Optional inpainting mask (white = edit, black = keep), same size as image. */
  maskUrl?: string;
  historySummaries?: string[];
}

export interface EditResponseBody {
  imageUrl: string;
  promptEn: string;
  summaryPl: string;
  provider: ProviderName;
  quality: Quality;
  costUsd: {
    claude: number;
    image: number;
    total: number;
  };
  claudeTokens: { input: number; output: number };
}

export interface HistoryNode {
  id: string;
  parentId: string | null;
  imageUrl: string;
  /** Polish instruction typed by the user; null for the root (uploaded) image */
  instructionPl: string | null;
  promptEn?: string;
  summaryPl?: string;
  provider?: ProviderName;
  quality?: Quality;
  costUsd?: number;
  /** Cost split for the usage counter (older nodes only have costUsd). */
  costClaudeUsd?: number;
  costImageUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
  /** User feedback on this edit — the trial-and-error learning dataset. */
  rating?: "up" | "down";
  createdAt: number;
}

export interface Project {
  id: string;
  name: string;
  nodes: HistoryNode[];
  currentNodeId: string;
  createdAt: number;
  updatedAt: number;
}

/** Monthly budgets (or current balances) per provider, set by the user in USD. */
export interface Budgets {
  anthropic: number | null;
  fal: number | null;
  google: number | null;
  updatedAt: number;
}

/** Document synced to Vercel Blob so history follows you across devices. */
export interface ProjectsDocument {
  projects: Project[];
  deletedIds: string[];
  budgets?: Budgets | null;
}
