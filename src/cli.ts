#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { collectEvidence } from "./aws.js";
import { investigate } from "./investigator.js";
import { safeJson, sanitize } from "./sanitize.js";
import { EVIDENCE_TOOLS, type EvidenceRequest, type EvidenceTool } from "./types.js";

const HELP = `eks-rca — read-only EKS incident investigator

Usage:
  eks-rca investigate --cluster NAME --incident "description" [options]
  eks-rca evidence <${[...EVIDENCE_TOOLS, "all"].join("|")}> --cluster NAME [options]

Options:
  --region REGION           AWS region (default: AWS_REGION or us-east-1)
  --profile PROFILE         Named local AWS profile (otherwise default credential chain)
  --lookback-hours HOURS    Bounded window: 1-168 (default: 24)
  --max-results COUNT       Per-source limit: 1-100 (default: 25)
  --fixture PATH            Read deterministic fixture JSON instead of AWS
  --incident TEXT           One-shot incident description; omitted invokes a prompt
  --help                    Show this help

Evidence commands are an allowlist. This tool never calls AWS mutating actions.`;

type Parsed = { command?: string; positional?: string; flags: Record<string, string> };

function parse(argv: string[]): Parsed {
  if (argv.length === 1 && argv[0] === "--help") return { flags: { help: "true" } };
  const command = argv[0];
  let positional: string | undefined;
  let start = 1;
  if (argv[1] && !argv[1].startsWith("--")) {
    positional = argv[1];
    start = 2;
  }
  const flags: Record<string, string> = {};
  for (let index = start; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith("--")) throw new Error(`Unexpected argument: ${current}`);
    const key = current.slice(2);
    if (key === "help") { flags.help = "true"; continue; }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    flags[key] = value;
    index += 1;
  }
  return { command, positional, flags };
}

function boundedInteger(value: string | undefined, defaultValue: number, name: string, min: number, max: number): number {
  const parsed = value === undefined ? defaultValue : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`--${name} must be an integer between ${min} and ${max}`);
  return parsed;
}

function requestFrom(flags: Record<string, string>): EvidenceRequest {
  if (!flags.cluster || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(flags.cluster)) throw new Error("--cluster must be a valid EKS cluster name");
  return {
    cluster: flags.cluster,
    region: flags.region ?? process.env.AWS_REGION ?? "us-east-1",
    profile: flags.profile,
    lookbackHours: boundedInteger(flags["lookback-hours"], 24, "lookback-hours", 1, 168),
    maxResults: boundedInteger(flags["max-results"], 25, "max-results", 1, 100),
    fixture: flags.fixture,
  };
}

async function promptIncident(): Promise<string> {
  if (!input.isTTY) throw new Error("--incident is required when stdin is not interactive");
  const readline = createInterface({ input, output });
  try {
    const answer = (await readline.question("Describe the EKS incident: ")).trim();
    if (!answer) throw new Error("An incident description is required");
    return answer;
  } finally {
    readline.close();
  }
}

async function run(): Promise<void> {
  const parsed = parse(process.argv.slice(2));
  if (parsed.flags.help || !parsed.command) { console.log(HELP); return; }
  const request = requestFrom(parsed.flags);
  if (parsed.command === "evidence") {
    if (!parsed.positional || (parsed.positional !== "all" && !EVIDENCE_TOOLS.includes(parsed.positional as EvidenceTool))) throw new Error(`Evidence tool must be one of: ${[...EVIDENCE_TOOLS, "all"].join(", ")}`);
    const tools = parsed.positional === "all" ? EVIDENCE_TOOLS : [parsed.positional as EvidenceTool];
    const results = await Promise.all(tools.map((tool) => collectEvidence(tool, request)));
    console.log(safeJson(results.length === 1 ? results[0] : results));
    return;
  }
  if (parsed.command === "investigate") {
    const incident = parsed.flags.incident ?? await promptIncident();
    console.log(safeJson(await investigate(incident, request)));
    return;
  }
  throw new Error(`Unknown command: ${parsed.command}`);
}

run().catch((error: unknown) => {
  console.error(`Error: ${sanitize(error)}`);
  process.exitCode = 1;
});

export const __testables = { parse, boundedInteger, requestFrom };
