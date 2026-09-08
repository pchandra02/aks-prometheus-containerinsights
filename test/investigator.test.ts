import { describe, expect, it } from "vitest";
import { collectInvestigationEvidence, serializeEvidence, __testables } from "../src/investigator.js";
import type { EvidenceRequest, EvidenceResult } from "../src/types.js";

const request: EvidenceRequest = {
  cluster: "demo", region: "us-west-2", lookbackHours: 24, maxResults: 25, fixture: "fixtures/incident.json",
};

describe("investigation evidence harness", () => {
  it("assembles every fixture source without AWS calls or Codex execution", async () => {
    const evidence = await collectInvestigationEvidence(request);
    expect(evidence).toHaveLength(8);
    expect(evidence.every((result) => result.status === "ok")).toBe(true);
    expect(evidence.every((result) => result.citation.query.startsWith("fixture:"))).toBe(true);
  });

  it("serializes untrusted evidence with redaction and a hard character bound", () => {
    const evidence: EvidenceResult[] = Array.from({ length: 60 }, (_, index) => ({
      tool: "logs", status: "ok", citation: { source: "fixture", retrievedAt: "now", query: "fixture" },
      data: index === 0 ? `token=plain-text-secret ${"x".repeat(2_000)}` : "x".repeat(2_000),
    }));
    const serialized = serializeEvidence(evidence);
    expect(serialized).not.toContain("plain-text-secret");
    expect(serialized).toContain("[REDACTED]");
    expect(serialized.length).toBeLessThanOrEqual(__testables.MAX_EVIDENCE_PROMPT_CHARS + 64);
    expect(serialized).toContain("[TRUNCATED:");
  });

  it("requires a citation for every timeline item in the strict output schema", () => {
    const timeline = __testables.reportSchema.properties.timeline.items;
    expect(timeline.required).toEqual(["time", "event", "citation"]);
  });
});
