# EKS RCA Investigator

A local, report-only TypeScript CLI for investigating EKS incidents. It gathers bounded AWS evidence and asks the official [`@openai/codex-sdk`](https://www.npmjs.com/package/@openai/codex-sdk) agent to produce a structured root-cause analysis. It is intentionally not an operator tool: there are no write, delete, update, scale, restart, or remediation actions.

## Requirements and setup

- Node.js 20 or newer
- Local AWS credentials from a named profile or the standard AWS default credential chain (environment, shared files, web identity, ECS/EC2 role, etc.)
- A working Codex CLI authentication state or `OPENAI_API_KEY` for `investigate`

```bash
npm install
cp .env.example .env # optional; do not commit .env
npm run build

# use the default credential chain
node dist/cli.js evidence all --cluster production --region us-east-1

# choose a local profile and produce an RCA
node dist/cli.js investigate --cluster production --region us-east-1 --profile incident-readonly \
  --incident "Prometheus targets began disappearing at 09:20 UTC"
```

Omit `--incident` on an interactive terminal to be prompted. `--region` defaults to `AWS_REGION`, then `us-east-1`; `--profile` is optional. Every request has a bounded `--lookback-hours` range of **1–168** (default 24) and `--max-results` range of **1–100** (default 25).

## Evidence surface

`evidence` accepts exactly one named source or `all`:

| Tool | Read-only evidence |
| --- | --- |
| `cluster` | Safe operational EKS summary and node-group names (certificate authority data is excluded) |
| `nodes` | EC2 instances tagged with `aws:eks:cluster-name` |
| `load-balancers` | ELBv2 load balancers in the EKS cluster VPC |
| `logs` | matching `/aws/eks/<cluster>` log groups and bounded events from the first group |
| `metrics` | CloudWatch `ContainerInsights` failed-node metric |
| `cloudtrail` | CloudTrail events whose resource name is the cluster |
| `config` | AWS Config EKS cluster resource inventory query |
| `health` | AWS Health open/upcoming events via its `us-east-1` global endpoint (account-wide) |

Examples:

```bash
node dist/cli.js evidence logs --cluster production --region us-east-1 --lookback-hours 6 --max-results 50
node dist/cli.js evidence all --cluster demo --fixture fixtures/incident.json
npm run dev -- evidence nodes --cluster demo --fixture fixtures/incident.json
```

Fixture mode makes no AWS calls and is intended for local tests/demos. The final JSON report contains: `executiveSummary`, `timeline`, `rootCause`, `contributingFactors`, `evidenceCitations`, `confidence`, `remediationRecommendations`, and `unknowns`.

## Architecture and safety model

1. `src/cli.ts` parses a narrow command grammar and enforces cluster-name validation, lookback, and result limits.
2. `src/aws.ts` owns the deterministic evidence allowlist. It uses only AWS SDK `Describe`, `List`, `Lookup`, `Filter`, `GetMetricData`, and Config `Select` commands. There is no generic AWS CLI or generic SDK command facility.
3. `src/investigator.ts` collects the complete fixed evidence allowlist in the host process before starting Codex. Codex receives only sanitized, character-bounded evidence as untrusted data, with instructions to ignore embedded instructions. Its SDK thread has `sandboxMode: "read-only"`, approvals disabled, networking disabled, and a JSON output schema; it has no evidence-collection work.
4. `src/sanitize.ts` redacts common access-key, session-token, authorization, password, and secret patterns from errors and JSON strings before terminal output.

The agent is an analyst, not a trusted source of operational truth. Treat conclusions as hypotheses until confirmed; permission errors and missing telemetry lower confidence. The process does not persist collected evidence, credentials, or reports unless a caller redirects output themselves. AWS Health is always queried through `us-east-1`, independently of the selected EKS region.

### IAM guidance

Use a dedicated least-privilege role/profile. Do **not** attach write policies or administrative access. Start with the policy below and tailor resource scoping where your account supports it. Some services do not support resource-level restrictions for these discovery APIs. AWS Health is account-wide and may require Business/Enterprise Support; omission simply returns a sanitized unavailable/error result.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["eks:DescribeCluster", "eks:ListNodegroups"], "Resource": "*" },
    { "Effect": "Allow", "Action": ["ec2:DescribeInstances", "elasticloadbalancing:DescribeLoadBalancers"], "Resource": "*" },
    { "Effect": "Allow", "Action": ["logs:DescribeLogGroups", "logs:FilterLogEvents"], "Resource": "*" },
    { "Effect": "Allow", "Action": ["cloudwatch:GetMetricData"], "Resource": "*" },
    { "Effect": "Allow", "Action": ["cloudtrail:LookupEvents"], "Resource": "*" },
    { "Effect": "Allow", "Action": ["config:SelectResourceConfig"], "Resource": "*" },
    { "Effect": "Allow", "Action": ["health:DescribeEvents"], "Resource": "*" }
  ]
}
```

The default implementation does not assume roles. Configure a named profile with your preferred role-assumption mechanism in `~/.aws/config`; the AWS SDK default provider chain handles it.

## Development

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

The production dependencies are the official AWS SDK clients/credential chain and `@openai/codex-sdk`; tooling stays in development dependencies.
