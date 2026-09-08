export const EVIDENCE_TOOLS = [
  "cluster",
  "nodes",
  "load-balancers",
  "logs",
  "metrics",
  "cloudtrail",
  "config",
  "health",
] as const;

export type EvidenceTool = (typeof EVIDENCE_TOOLS)[number];

export interface EvidenceRequest {
  cluster: string;
  region: string;
  profile?: string;
  lookbackHours: number;
  maxResults: number;
  fixture?: string;
}

export interface EvidenceCitation {
  source: string;
  retrievedAt: string;
  query: string;
}

export interface EvidenceResult {
  tool: EvidenceTool;
  status: "ok" | "unavailable" | "error";
  citation: EvidenceCitation;
  data: unknown;
  error?: string;
}

export interface InvestigationReport {
  executiveSummary: string;
  timeline: Array<{ time: string; event: string; citation: string }>;
  rootCause: string;
  contributingFactors: string[];
  evidenceCitations: Array<{ id: string; source: string; detail: string }>;
  confidence: "low" | "medium" | "high";
  remediationRecommendations: string[];
  unknowns: string[];
}
