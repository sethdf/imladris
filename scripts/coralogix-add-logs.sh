#!/bin/bash
# Upgrades an existing Coralogix-instrumented ECS task definition to add log routing
# Adds FluentBit log router (output: Coralogix /logs/v1/singles) and updates log driver
# Usage: ./coralogix-add-logs.sh <task-family> <environment> [--apply]
#
# Prerequisites: Task must already have otel-collector sidecar from coralogix-inject-sidecar.sh
#
# Examples:
#   ./coralogix-add-logs.sh quality-auth-service quality          # Preview only
#   ./coralogix-add-logs.sh quality-auth-service quality --apply  # Register + update service
#
# Required env vars (or edit below):
#   CORALOGIX_PRIVATE_KEY  — Send-Your-Data API key
#   CORALOGIX_REGION       — us1, us2, eu1, eu2, ap1, ap2, ap3 (default: us1)

set -euo pipefail

TASK_FAMILY="${1:?Usage: $0 <task-family> <environment> [--apply]}"
ENVIRONMENT="${2:?Usage: $0 <task-family> <environment> [--apply]}"
APPLY="${3:-}"
PROFILE="prod-admin"
REGION="us-east-1"
CLUSTER="quality"

# Coralogix credentials — set via env or edit here
CORALOGIX_PRIVATE_KEY="${CORALOGIX_PRIVATE_KEY:?CORALOGIX_PRIVATE_KEY env var required}"
CORALOGIX_REGION="${CORALOGIX_REGION:-us1}"

# Resolve ingress endpoint from region
case "${CORALOGIX_REGION}" in
  us1) CORALOGIX_INGRESS="ingress.us1.coralogix.com" ;;
  us2) CORALOGIX_INGRESS="ingress.us2.coralogix.com" ;;
  eu1) CORALOGIX_INGRESS="ingress.eu1.coralogix.com" ;;
  eu2) CORALOGIX_INGRESS="ingress.eu2.coralogix.com" ;;
  ap1) CORALOGIX_INGRESS="ingress.ap1.coralogix.com" ;;
  ap2) CORALOGIX_INGRESS="ingress.ap2.coralogix.com" ;;
  ap3) CORALOGIX_INGRESS="ingress.ap3.coralogix.com" ;;
  *)   echo "ERROR: Unknown region '${CORALOGIX_REGION}'"; exit 1 ;;
esac

# Extract service name from task family (remove environment prefix)
SERVICE_NAME="${TASK_FAMILY#${ENVIRONMENT}-}"

echo "=== Coralogix Logs Upgrade ==="
echo "Task Family: ${TASK_FAMILY}"
echo "Service Name: ${SERVICE_NAME}"
echo "Environment: ${ENVIRONMENT}"
echo "Coralogix Region: ${CORALOGIX_REGION} → ${CORALOGIX_INGRESS}"
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
  echo "ERROR: No otel-collector sidecar found. Run coralogix-inject-sidecar.sh first."
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
  echo "WARNING: Task definition already has log-router. Skipping."
  exit 0
fi

# Build the upgraded task definition
echo "Building task definition with FluentBit log router → Coralogix..."
NEW_TASKDEF=$(echo "${CURRENT_TASKDEF}" | python3 -c "
import json, sys

data = json.load(sys.stdin)['taskDefinition']

# Remove metadata fields
for k in ['taskDefinitionArn','revision','status','requiresAttributes','compatibilities','registeredAt','registeredBy','deregisteredAt']:
    data.pop(k, None)

service_name = '${SERVICE_NAME}'
environment = '${ENVIRONMENT}'
private_key = '${CORALOGIX_PRIVATE_KEY}'
ingress = '${CORALOGIX_INGRESS}'
family = data['family']

# --- 1. FluentBit log router → Coralogix HTTP ---
# Coralogix FluentBit output plugin:
#   URI: /logs/v1/singles (NOT /logs/json like SigNoz)
#   Header: Authorization Bearer <private_key>
#   Requires: applicationName, subsystemName fields in payload
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

# --- 2. Switch app container log driver to awsfirelens → Coralogix ---
infra_names = {'otel-dotnet-init', 'otel-collector', 'log-router'}
for c in data['containerDefinitions']:
    if c['name'] not in infra_names:
        c['logConfiguration'] = {
            'logDriver': 'awsfirelens',
            'options': {
                # Coralogix expects /logs/v1/singles (not /logs/json used by SigNoz)
                'Name': 'http',
                'Host': ingress,
                'Port': '443',
                'URI': '/logs/v1/singles',
                'Format': 'json_lines',
                'Header': f'Authorization Bearer {private_key}',
                'tls': 'On',
                'tls.verify': 'On',
                'Retry_Limit': '2',
                'compress': 'gzip'
            },
            'secretOptions': []
        }
        # Add dependency on log-router
        deps = c.get('dependsOn', [])
        if not any(d['containerName'] == 'log-router' for d in deps):
            deps.append({'containerName': 'log-router', 'condition': 'START'})
        c['dependsOn'] = deps

# --- 3. Insert log-router as first container ---
containers = data['containerDefinitions']
containers = [c for c in containers if c['name'] != 'log-router']
data['containerDefinitions'] = [log_router] + containers

print(json.dumps(data, indent=2))
")

# Save to file for review
OUTPUT_FILE="/tmp/coralogix-logs-taskdef-${SERVICE_NAME}.json"
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
