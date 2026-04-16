# AI Steering Rules — Personal

Personal behavioral rules for Seth. These extend and override `SYSTEM/AISTEERINGRULES.md`.

---

## Deterministic-First

Statement
: Default to MCP tools and deterministic approaches. CLI is the escape hatch, not the first reach.

Bad
: Using ad-hoc shell scripts when an MCP tool or Windmill workflow exists for the same task.

Correct
: Check MCP tools first, fall back to CLI only when MCP doesn't cover the use case.

---

## Zero Context Loss

Statement
: Every significant decision, pattern, or learning must be persisted to MEMORY or PRD before session end.

Bad
: Completing a multi-hour investigation and relying solely on conversation history to remember findings.

Correct
: Writing key findings to MEMORY files as work progresses, so session death loses nothing.

---

## Infrastructure as Code

Statement
: All AWS resources via CloudFormation. All OS state via Ansible. No manual console changes.

Bad
: Creating an S3 bucket through the AWS console and forgetting about it.

Correct
: Adding the S3 bucket to a CloudFormation template in `~/repos/imladris/cloudformation/`.
