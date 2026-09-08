import { describe, expect, it } from "vitest";
import { __testables, collectEvidence } from "../src/aws.js";
import { sanitize } from "../src/sanitize.js";
import type { EvidenceRequest } from "../src/types.js";

const request: EvidenceRequest = {
  cluster: "demo", region: "us-east-1", lookbackHours: 24, maxResults: 25, fixture: "fixtures/incident.json",
};

describe("fixture evidence collection", () => {
  it("returns deterministic fixture data without AWS credentials", async () => {
    const result = await collectEvidence("nodes", request);
    expect(result.status).toBe("ok");
    expect(result.citation.query).toContain("fixture:fixtures/incident.json#nodes");
    expect(result.data).toEqual([{ instanceId: "i-0123456789abcdef0", state: "running", instanceType: "m5.large" }]);
  });

  it("sanitizes common AWS credential material", () => {
    expect(sanitize("Authorization=Bearer secret-value AKIA1234567890ABCDEF")).not.toContain("secret-value");
    expect(sanitize("Authorization=Bearer secret-value AKIA1234567890ABCDEF")).not.toContain("AKIA1234567890ABCDEF");
    expect(sanitize("token=plain-text-secret")).toBe("token=[REDACTED]");
  });

  it("uses corrected managed-node, Container Insights, and Health constants", () => {
    expect(__testables.MANAGED_NODE_TAG).toBe("tag:aws:eks:cluster-name");
    expect(__testables.CONTAINER_INSIGHTS_NAMESPACE).toBe("ContainerInsights");
    expect(__testables.AWS_HEALTH_REGION).toBe("us-east-1");
  });

  it("excludes certificate authority data from a cluster summary", () => {
    const summary = __testables.summarizeCluster({
      name: "demo", status: "ACTIVE", certificateAuthority: { data: "sensitive-ca" }, endpoint: "https://example.invalid",
    }, ["workers"]);
    expect(summary).toMatchObject({ name: "demo", endpoint: "https://example.invalid", nodegroups: ["workers"] });
    expect(JSON.stringify(summary)).not.toContain("sensitive-ca");
  });
});
