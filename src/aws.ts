import { CloudTrailClient, LookupEventsCommand } from "@aws-sdk/client-cloudtrail";
import { CloudWatchClient, GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { CloudWatchLogsClient, DescribeLogGroupsCommand, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { ConfigServiceClient, SelectResourceConfigCommand } from "@aws-sdk/client-config-service";
import { EC2Client, DescribeInstancesCommand } from "@aws-sdk/client-ec2";
import { EKSClient, DescribeClusterCommand, ListNodegroupsCommand, type Cluster } from "@aws-sdk/client-eks";
import { ElasticLoadBalancingV2Client, DescribeLoadBalancersCommand } from "@aws-sdk/client-elastic-load-balancing-v2";
import { HealthClient, DescribeEventsCommand } from "@aws-sdk/client-health";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import type { EvidenceRequest, EvidenceResult, EvidenceTool } from "./types.js";
import { sanitize } from "./sanitize.js";

const now = () => new Date();
const compact = <T extends Record<string, unknown>>(value: T) => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
const MANAGED_NODE_TAG = "tag:aws:eks:cluster-name";
const CONTAINER_INSIGHTS_NAMESPACE = "ContainerInsights";
const AWS_HEALTH_REGION = "us-east-1";

function summarizeCluster(details: Cluster | undefined, nodegroups: string[] | undefined) {
  return compact({
    name: details?.name, arn: details?.arn, status: details?.status, version: details?.version,
    platformVersion: details?.platformVersion, endpoint: details?.endpoint, createdAt: details?.createdAt,
    healthIssues: details?.health?.issues, vpcId: details?.resourcesVpcConfig?.vpcId,
    endpointPublicAccess: details?.resourcesVpcConfig?.endpointPublicAccess,
    endpointPrivateAccess: details?.resourcesVpcConfig?.endpointPrivateAccess,
    ipFamily: details?.kubernetesNetworkConfig?.ipFamily, nodegroups,
  });
}

interface AwsClients {
  eks: EKSClient;
  ec2: EC2Client;
  elbv2: ElasticLoadBalancingV2Client;
  logs: CloudWatchLogsClient;
  cloudwatch: CloudWatchClient;
  cloudtrail: CloudTrailClient;
  config: ConfigServiceClient;
  health: HealthClient;
}

function clientsFor(request: EvidenceRequest): AwsClients {
  const credentials = defaultProvider(request.profile ? { profile: request.profile } : {});
  const options = { region: request.region, credentials };
  return {
    eks: new EKSClient(options), ec2: new EC2Client(options), elbv2: new ElasticLoadBalancingV2Client(options),
    logs: new CloudWatchLogsClient(options), cloudwatch: new CloudWatchClient(options), cloudtrail: new CloudTrailClient(options),
    config: new ConfigServiceClient(options), health: new HealthClient({ ...options, region: AWS_HEALTH_REGION }),
  };
}

function citation(tool: EvidenceTool, request: EvidenceRequest, query: string) {
  const region = tool === "health" ? AWS_HEALTH_REGION : request.region;
  return { source: `aws:${tool}:${region}`, retrievedAt: now().toISOString(), query };
}

async function collectLive(tool: EvidenceTool, request: EvidenceRequest): Promise<EvidenceResult> {
  const clients = clientsFor(request);
  const end = now();
  const start = new Date(end.getTime() - request.lookbackHours * 3_600_000);
  try {
    switch (tool) {
      case "cluster": {
        const cluster = await clients.eks.send(new DescribeClusterCommand({ name: request.cluster }));
        const nodegroups = await clients.eks.send(new ListNodegroupsCommand({ clusterName: request.cluster, maxResults: request.maxResults }));
        const summary = summarizeCluster(cluster.cluster, nodegroups.nodegroups);
        return ok(tool, request, `DescribeCluster(${request.cluster}), ListNodegroups`, summary);
      }
      case "nodes": {
        const output = await clients.ec2.send(new DescribeInstancesCommand({
          Filters: [{ Name: MANAGED_NODE_TAG, Values: [request.cluster] }], MaxResults: request.maxResults,
        }));
        const instances = (output.Reservations ?? []).flatMap((reservation) => reservation.Instances ?? []).map((instance) => compact({
          instanceId: instance.InstanceId, state: instance.State?.Name, instanceType: instance.InstanceType,
          availabilityZone: instance.Placement?.AvailabilityZone, launchTime: instance.LaunchTime, privateIp: instance.PrivateIpAddress,
        }));
        return ok(tool, request, `DescribeInstances(${MANAGED_NODE_TAG}=${request.cluster})`, instances);
      }
      case "load-balancers": {
        const cluster = await clients.eks.send(new DescribeClusterCommand({ name: request.cluster }));
        const output = await clients.elbv2.send(new DescribeLoadBalancersCommand({ PageSize: request.maxResults }));
        const balancers = (output.LoadBalancers ?? []).filter((lb) => lb.VpcId === cluster.cluster?.resourcesVpcConfig?.vpcId).slice(0, request.maxResults);
        const summary = balancers.map((lb) => compact({
          arn: lb.LoadBalancerArn, name: lb.LoadBalancerName, state: lb.State?.Code, type: lb.Type,
          scheme: lb.Scheme, availabilityZones: lb.AvailabilityZones?.map((zone) => zone.ZoneName),
        }));
        return ok(tool, request, "DescribeCluster(vpc), DescribeLoadBalancers(vpc)", summary);
      }
      case "logs": {
        const groups = await clients.logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: `/aws/eks/${request.cluster}`, limit: request.maxResults }));
        const group = groups.logGroups?.[0]?.logGroupName;
        const events = group ? await clients.logs.send(new FilterLogEventsCommand({ logGroupName: group, startTime: start.getTime(), endTime: end.getTime(), limit: request.maxResults })) : undefined;
        return ok(tool, request, `DescribeLogGroups(/aws/eks/${request.cluster}), FilterLogEvents(${request.lookbackHours}h)`, compact({ logGroups: groups.logGroups, events: events?.events }));
      }
      case "metrics": {
        const metrics = await clients.cloudwatch.send(new GetMetricDataCommand({
          StartTime: start, EndTime: end, ScanBy: "TimestampDescending", MaxDatapoints: request.maxResults,
          MetricDataQueries: [{ Id: "clusterfailednodecount", MetricStat: { Metric: { Namespace: CONTAINER_INSIGHTS_NAMESPACE, MetricName: "cluster_failed_node_count", Dimensions: [{ Name: "ClusterName", Value: request.cluster }] }, Period: 300, Stat: "Maximum" }, ReturnData: true }],
        }));
        return ok(tool, request, `GetMetricData(ContainerInsights cluster_failed_node_count, ${request.lookbackHours}h)`, metrics.MetricDataResults);
      }
      case "cloudtrail": {
        const events = await clients.cloudtrail.send(new LookupEventsCommand({ StartTime: start, EndTime: end, MaxResults: request.maxResults, LookupAttributes: [{ AttributeKey: "ResourceName", AttributeValue: request.cluster }] }));
        return ok(tool, request, `LookupEvents(ResourceName=${request.cluster}, ${request.lookbackHours}h)`, events.Events);
      }
      case "config": {
        const query = `SELECT resourceId, resourceType, configurationItemCaptureTime WHERE resourceType = 'AWS::EKS::Cluster' AND resourceId = '${request.cluster.replace(/'/g, "")}'`;
        const result = await clients.config.send(new SelectResourceConfigCommand({ Expression: query, Limit: request.maxResults }));
        return ok(tool, request, query, result.Results);
      }
      case "health": {
        const result = await clients.health.send(new DescribeEventsCommand({ filter: { startTimes: [{ from: start, to: end }], eventStatusCodes: ["open", "upcoming"] }, maxResults: request.maxResults }));
        return ok(tool, request, `DescribeEvents(us-east-1 global endpoint; open/upcoming, ${request.lookbackHours}h; account-wide availability)`, result.events);
      }
    }
  } catch (error) {
    return { tool, status: "error", citation: citation(tool, request, "read-only AWS SDK request"), data: null, error: sanitize(error) };
  }
}

function ok(tool: EvidenceTool, request: EvidenceRequest, query: string, data: unknown): EvidenceResult {
  return { tool, status: "ok", citation: citation(tool, request, query), data };
}

export async function collectEvidence(tool: EvidenceTool, request: EvidenceRequest): Promise<EvidenceResult> {
  if (request.fixture) return loadFixture(tool, request);
  return collectLive(tool, request);
}

export const __testables = { MANAGED_NODE_TAG, CONTAINER_INSIGHTS_NAMESPACE, AWS_HEALTH_REGION, summarizeCluster };

async function loadFixture(tool: EvidenceTool, request: EvidenceRequest): Promise<EvidenceResult> {
  const { readFile } = await import("node:fs/promises");
  try {
    const parsed: unknown = JSON.parse(await readFile(request.fixture!, "utf8"));
    const fixtures = parsed as Partial<Record<EvidenceTool, unknown>>;
    return ok(tool, request, `fixture:${request.fixture}#${tool}`, fixtures[tool] ?? { message: "No fixture supplied for this tool" });
  } catch (error) {
    return { tool, status: "error", citation: citation(tool, request, `fixture:${request.fixture}`), data: null, error: sanitize(error) };
  }
}
