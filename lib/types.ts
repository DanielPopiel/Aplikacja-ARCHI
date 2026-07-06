export type ProviderName = "flux" | "gemini";

export interface EditRequestBody {
  imageUrl: string;
  instruction: string;
  provider?: ProviderName;
  historySummaries?: string[];
}

export interface EditResponseBody {
  imageUrl: string;
  promptEn: string;
  summaryPl: string;
  provider: ProviderName;
  costUsd: {
    claude: number;
    image: number;
    total: number;
  };
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
  costUsd?: number;
  createdAt: number;
}

export interface Project {
  id: string;
  name: string;
  nodes: HistoryNode[];
  currentNodeId: string;
  createdAt: number;
}
