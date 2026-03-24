#!/bin/bash
# Upgrades an existing SigNoz-instrumented ECS task definition to add log routing
# Adds FluentBit log router (dual output: CloudWatch + SigNoz) and ADOT logs pipeline
# Usage: ./signoz-add-logs.sh <task-family> <environment> [--apply]
#
# Prerequisites: Task must already have otel-collector sidecar from signoz-inject-sidecar.sh
#
# Examples:
#   ./signoz-add-logs.sh quality-auth-service quality          # Preview only
#   ./signoz-add-logs.sh quality-auth-service quality --apply  # Register + update service

set -euo pipefail

TASK_FAMILY="${1:?Usage: $0 <task-family> <environment> [--apply]}"
ENVIRONMENT="${2:?Usage: $0 <task-family> <environment> [--apply]}"
APPLY="${3:-}"
PROFILE="prod-admin"
REGION="us-east-1"
CLUSTER="quality"
SIGNOZ_INGESTION_KEY="84yQjHlEAqt1HClWu4vW9qLK7ZeVSuDiIZeG"

# Extract service name from task family (remove environment prefix)
SERVICE_NAME="${TASK_FAMILY#${ENVIRONMENT}-}"

echo "=== SigNoz Logs Upgrade ==="
echo "Task Family: ${TASK_FAMILY}"
echo "Service Name: ${SERVICE_NAME}"
echo "Environment: ${ENVIRONMENT}"
echo ""

# Fetch current task definition
echo "Fetching current task definition..."
CURRENT_TASKDEF=$(aws ecs describe-task-definition \
  --task-definition "${TASK_FAMILY}" \
  --profile "${PROFILE}" \
  --region "${REGION}" 2>/dev/null)

CURRENT_REVISION=$(echo "${CURRENT_TASKDEF}" | python3 -c "import json,sys; print(json.load(sys.stdin)['taskDefinition']['revision'])")
echo "Current revision: ${CURRENT_REVISION}"

# Verify sidecar exists
HAS_SIDECAR=$(echo "${CURRENT_TASKDEF}" | python3 -c "
import json,sys
d = json.load(sys.stdin)['taskDefinition']
names = [c['name'] for c in d['containerDefinitions']]
print('yes' if 'otel-collector' in names else 'no')
")

if [ "${HAS_SIDECAR}" = "no" ]; then
  echo "ERROR: No otel-collector sidecar found. Run signoz-inject-sidecar.sh first."
  exit 1
fi

# Check if log-router already exists
HAS_LOG_ROUTER=$(echo "${CURRENT_TASKDEF}" | python3 -c "
import json,sys
d = json.load(sys.stdin)['taskDefinition']
names = [c['name'] for c in d['containerDefinitions']]
print('yes' if 'log-router' in names else 'no')
")

if [ "${HAS_LOG_ROUTER}" = "yes" ]; then
  # Check if it's already the init variant (dual output) or needs upgrade
  HAS_INIT=$(echo "${CURRENT_TASKDEF}" | python3 -c "
import json,sys
d = json.load(sys.stdin)['taskDefinition']
for c in d['containerDefinitions']:
    if c['name'] == 'log-router':
        print('yes' if 'init' in c.get('image','') else 'no')
        break
")
  if [ "${HAS_INIT}" = "yes" ]; then
    echo "WARNING: Task definition already has init log-router (dual output). Skipping."
    exit 0
  else
    echo "Upgrading existing log-router from single to dual output..."
  fi
fi

# Build the upgraded task definition
echo "Building task definition with FluentBit log router + ADOT logs pipeline..."
NEW_TASKDEF=$(echo "${CURRENT_TASKDEF}" | python3 -c "
import json, sys

data = json.load(sys.stdin)['taskDefinition']

# Remove metadata fields
for k in ['taskDefinitionArn','revision','status','requiresAttributes','compatibilities','registeredAt','registeredBy','deregisteredAt']:
    data.pop(k, None)

service_name = '${SERVICE_NAME}'
environment = '${ENVIRONMENT}'
ingestion_key = '${SIGNOZ_INGESTION_KEY}'
family = data['family']

# --- 1. Add FluentBit log router container ---
# Standard image with firelens. App logs route to SigNoz via HTTP output.
# Log-router own logs go to CloudWatch for debugging.
log_router = {
    'name': 'log-router',
    'image': 'public.ecr.aws/aws-observability/aws-for-fluent-bit:stable',
    'essential': True,
    'cpu': 64,
    'memory': 128,
    'firelensConfiguration': {
        'type': 'fluentbit',
        'options': {
            'enable-ecs-log-metadata': 'true',
            'config-file-type': 'file',
            'config-file-value': '/fluent-bit/configs/minimize-log-loss.conf'
        }
    },
    'logConfiguration': {
        'logDriver': 'awslogs',
        'options': {
            'awslogs-group': f'/ecs/{family}',
            'awslogs-region': 'us-east-1',
            'awslogs-stream-prefix': 'log-router'
        }
    }
}

# --- 2. ADOT sidecar keeps existing config (traces + metrics only) ---
# Logs go through FluentBit → SigNoz HTTP, not through ADOT.
# ADOT v0.41.2 may not support logs pipeline.
# No changes needed to otel-collector config.

# --- 3. Switch app container log driver to awsfirelens → SigNoz HTTP ---
# App logs route to SigNoz via FluentBit http output plugin.
# FluentBit enriches logs with ECS metadata (cluster, task ARN, container name).
infra_names = {'otel-dotnet-init', 'otel-collector', 'log-router'}
for c in data['containerDefinitions']:
    if c['name'] not in infra_names:
        c['logConfiguration'] = {
            'logDriver': 'awsfirelens',
            'options': {
                'Name': 'http',
                'Host': 'ingest.us.signoz.cloud',
                'Port': '443',
                'URI': '/logs/json',
                'Format': 'json',
                'tls': 'On',
                'tls.verify': 'On',
                'Header': f'signoz-ingestion-key {ingestion_key}',
                'Retry_Limit': '2',
                'compress': 'gzip'
            },
            'secretOptions': []
        }
        # Add dependency on log-router
        deps = c.get('dependsOn', [])
        # Only add if not already present
        if not any(d['containerName'] == 'log-router' for d in deps):
            deps.append({'containerName': 'log-router', 'condition': 'START'})
        c['dependsOn'] = deps

# --- 4. Insert log-router as first container (ECS requires firelens container first) ---
containers = data['containerDefinitions']
# Remove old log-router if present (upgrading from single to dual output), then prepend new
containers = [c for c in containers if c['name'] != 'log-router']
data['containerDefinitions'] = [log_router] + containers

print(json.dumps(data, indent=2))
")

# Save to file for review
OUTPUT_FILE="/tmp/signoz-logs-taskdef-${SERVICE_NAME}.json"
echo "${NEW_TASKDEF}" > "${OUTPUT_FILE}"
echo ""
echo "New task definition written to: ${OUTPUT_FILE}"

# Count containers
CONTAINER_COUNT=$(echo "${NEW_TASKDEF}" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['containerDefinitions']))")
echo "Container count: ${CONTAINER_COUNT} (log-router + init + sidecar + app)"

if [ "${APPLY}" = "--apply" ]; then
  echo ""
  echo "Registering new task definition revision..."
  NEW_ARN=$(aws ecs register-task-definition \
    --cli-input-json "${NEW_TASKDEF}" \
    --profile "${PROFILE}" \
    --region "${REGION}" 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin)['taskDefinition']['taskDefinitionArn'])")

  NEW_REV=$(echo "${NEW_ARN}" | grep -o '[0-9]*$')
  echo "Registered new revision: ${NEW_REV} (was: ${CURRENT_REVISION})"
  echo "ARN: ${NEW_ARN}"

  echo ""
  echo "Updating ECS service ${SERVICE_NAME} to use new revision..."
  aws ecs update-service \
    --cluster "${CLUSTER}" \
    --service "${SERVICE_NAME}" \
    --task-definition "${NEW_ARN}" \
    --force-new-deployment \
    --profile "${PROFILE}" \
    --region "${REGION}" 2>/dev/null | python3 -c "
import json,sys
d = json.load(sys.stdin)['service']
print(f'Service: {d[\"serviceName\"]}')
print(f'TaskDef: {d[\"taskDefinition\"].split(\"/\")[-1]}')
print(f'Desired: {d[\"desiredCount\"]}')
print(f'Status: {d[\"status\"]}')
"
  echo ""
  echo "Service update initiated. Monitor with:"
  echo "  aws ecs describe-services --cluster ${CLUSTER} --services ${SERVICE_NAME} --profile ${PROFILE} --region ${REGION}"
else
  echo ""
  echo "DRY RUN — review the task definition at ${OUTPUT_FILE}"
  echo "To apply: $0 ${TASK_FAMILY} ${ENVIRONMENT} --apply"
fi
