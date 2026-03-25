// Windmill Script: Load Domain Knowledge
// Returns investigation runbook content matched to the alert's domain.
// Knowledge files live on host at ~/repos/imladris/knowledge/ (bind-mounted read-only).
// Deterministic domain classifier maps alert keywords to knowledge domains.

import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";

const KNOWLEDGE_DIR = "/home/ec2-user/repos/imladris/knowledge";

// Deterministic domain classifier — maps keywords to knowledge file names
const DOMAIN_KEYWORDS: Record<string, string[]> = {
  aws: [
    "ec2", "rds", "s3", "lambda", "ecs", "cloudwatch", "cloudtrail",
    "instance", "vpc", "security group", "iam", "sqs", "sns", "dynamodb",
    "elb", "alb", "nlb", "route53", "cloudfront", "eks", "fargate",
    "nat gateway", "subnet", "ami", "ebs", "kms",
  ],
  network: [
    "dns", "tls", "ssl", "certificate", "mx", "spf", "dkim", "dmarc",
    "connectivity", "timeout", "unreachable", "port", "firewall",
    "site24x7", "monitor", "down", "ping", "latency", "bandwidth",
  ],
  security: [
    "sign-in", "signin", "login", "suspicious", "compromise", "breach",
    "securonix", "siem", "threat", "violation", "brute force", "phishing",
    "malware", "ransomware", "vulnerability", "cve", "security group",
    "mfa", "multi-factor", "password spray",
  ],
  identity: [
    "user", "account", "okta", "azure ad", "entra", "mfa", "password",
    "access", "permission", "role", "group", "license", "onboarding",
    "offboarding", "service account", "app registration",
  ],
  application: [
    "sdp", "ticket", "vendor", "deployment", "deploy", "release",
    "change", "maintenance", "application", "api", "integration",
    "third-party", "3rd party", "service desk",
  ],
};

function classifyDomains(alertText: string): string[] {
  const lower = alertText.toLowerCase();
  const scores: Record<string, number> = {};

  for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
    let score = 0;
    for (const kw of keywords) {
      if (lower.includes(kw)) score++;
    }
    if (score > 0) scores[domain] = score;
  }

  // Return domains sorted by match count, or all if none match
  const sorted = Object.entries(scores)
    .sort((a, b) => b[1] - a[1])
    .map(([domain]) => domain);

  return sorted.length > 0 ? sorted.slice(0, 3) : Object.keys(DOMAIN_KEYWORDS);
}

export async function main(
  alert_text: string,
  domains?: string[],
): Promise<{
  domains_matched: string[];
  knowledge: Record<string, string>;
  available_domains: string[];
}> {
  // List available knowledge files
  const availableDomains: string[] = [];
  if (existsSync(KNOWLEDGE_DIR)) {
    for (const file of readdirSync(KNOWLEDGE_DIR)) {
      if (file.endsWith(".md")) {
        availableDomains.push(file.replace(".md", ""));
      }
    }
  }

  // Classify domains from alert text (or use explicit domains if provided)
  const matchedDomains = domains && domains.length > 0
    ? domains.filter(d => availableDomains.includes(d))
    : classifyDomains(alert_text).filter(d => availableDomains.includes(d));

  // Load knowledge for matched domains
  const knowledge: Record<string, string> = {};
  for (const domain of matchedDomains) {
    const filePath = join(KNOWLEDGE_DIR, `${domain}.md`);
    if (existsSync(filePath)) {
      knowledge[domain] = readFileSync(filePath, "utf-8");
    }
  }

  return {
    domains_matched: matchedDomains,
    knowledge,
    available_domains: availableDomains,
  };
}
