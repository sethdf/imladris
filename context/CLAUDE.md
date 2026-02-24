# Imladris Workstation

This is the Imladris v2 cloud workstation (EC2, BuxtonIT account 767448074758).

# Read the PAI system for system understanding and initiation
`read skills/PAI/SKILL.md`

## Context
- Read ~/.claude/MEMORY/MEMORY.md for architecture decisions (40 decisions)
- Read ~/.claude/MEMORY/cloud-workstation-vision.md for full spec, roadmap, and implementation checklist
- Read ~/.claude/MEMORY/devops-architecture.md for MCP and tooling patterns

## Current State
- Phase 1 Foundation is ~60% done (infrastructure deployed, tools installed)
- Remaining Phase 1: MCP server config, Windmill startup, hooks, credential setup
- Phases 2-6 are not started
- Full roadmap in cloud-workstation-vision.md under Implementation Roadmap

## Key Paths
- Repos: ~/repos/ (PAI, imladris)
- Skills: ~/.claude/skills/ -> ~/repos/PAI/skills/
- Agents: ~/.claude/agents/ -> ~/repos/PAI/agents/
- Memory: ~/.claude/MEMORY/ (WORK, STATE, LEARNING)
- CloudFormation: ~/repos/imladris/cloudformation/
- Bootstrap: ~/repos/imladris/bootstrap.sh
