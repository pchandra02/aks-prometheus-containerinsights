import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);

describe("evidence CLI", () => {
  it("uses fixture mode and validates bounded input", async () => {
    const { stdout } = await execute("npx", ["tsx", "src/cli.ts", "evidence", "nodes", "--cluster", "demo", "--fixture", "fixtures/incident.json", "--lookback-hours", "24", "--max-results", "2"], { cwd: process.cwd() });
    const result = JSON.parse(stdout) as { status: string; data: Array<{ instanceId: string }> };
    expect(result.status).toBe("ok");
    expect(result.data[0].instanceId).toBe("i-0123456789abcdef0");

    await expect(execute("npx", ["tsx", "src/cli.ts", "evidence", "nodes", "--cluster", "demo", "--fixture", "fixtures/incident.json", "--lookback-hours", "169"], { cwd: process.cwd() }))
      .rejects.toMatchObject({ stderr: expect.stringContaining("between 1 and 168") });
  });
});
