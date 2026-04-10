#!/bin/bash
# Injects ADOT sidecar + OTel .NET auto-instrumentation into an ECS task definition
# Routes telemetry to Coralogix instead of SigNoz
# Usage: ./coralogix-inject-sidecar.sh <task-family> <environment> [--apply]
#
# Examples:
#   ./coralogix-inject-sidecar.sh quality-auth-service quality          # Preview only
#   ./coralogix-inject-sidecar.sh quality-auth-service quality --apply  # Register + update service
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

echo "=== Coralogix Sidecar Injection ==="
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

# Check if sidecar already injected
HAS_SIDECAR=$(echo "${CURRENT_TASKDEF}" | python3 -c "
import json,sys
d = json.load(sys.stdin)['taskDefinition']
names = [c['name'] for c in d['containerDefinitions']]
print('yes' if 'otel-collector' in names else 'no')
")

if [ "${HAS_SIDECAR}" = "yes" ]; then
  echo "WARNING: Task definition already has otel-collector sidecar. Skipping."
  exit 0
fi

# Build the new task definition
echo "Building new task definition with ADOT sidecar (Coralogix backend)..."
NEW_TASKDEF=$(echo "${CURRENT_TASKDEF}" | SVCNAME="${SERVICE_NAME}" ENVNAME="${ENVIRONMENT}" CXKEY="${CORALOGIX_PRIVATE_KEY}" CXINGRESS="${CORALOGIX_INGRESS}" python3 -c '
import json, sys, os

data = json.load(sys.stdin)["taskDefinition"]

# Remove metadata fields
for k in ["taskDefinitionArn","revision","status","requiresAttributes","compatibilities","registeredAt","registeredBy","deregisteredAt"]:
    data.pop(k, None)

service_name = os.environ["SVCNAME"]
environment = os.environ["ENVNAME"]
private_key = os.environ["CXKEY"]
ingress = os.environ["CXINGRESS"]

# Add shared volume for auto-instrumentation files
data["volumes"] = data.get("volumes", [])
data["volumes"].append({
    "name": "otel-auto-instrumentation",
    "host": {}
})

# OTel .NET init container
init_container = {
    "name": "otel-dotnet-init",
    "image": "945243322929.dkr.ecr.us-east-1.amazonaws.com/otel-dotnet-init:1.14.1",
    "essential": False,
    "command": ["cp", "-r", "/autoinstrumentation/.", "/otel-auto-instrumentation/"],
    "mountPoints": [{
        "sourceVolume": "otel-auto-instrumentation",
        "containerPath": "/otel-auto-instrumentation",
        "readOnly": False
    }],
    "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
            "awslogs-group": "/ecs/" + data["family"],
            "awslogs-region": "us-east-1",
            "awslogs-stream-prefix": "otel-init"
        }
    }
}

# ADOT Collector sidecar — Coralogix OTLP exporter
otel_config = f"""receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318
  awsecscontainermetrics:
    collection_interval: 30s
processors:
  batch:
    send_batch_size: 1000
    timeout: 10s
  resourcedetection:
    detectors: [env, ecs]
    timeout: 5s
  resource/cx:
    attributes:
      - key: cx.application.name
        value: buxton
        action: upsert
      - key: cx.subsystem.name
        value: {environment}
        action: upsert
exporters:
  otlp:
    endpoint: {ingress}:443
    headers:
      Authorization: "Bearer {private_key}"
service:
  telemetry:
    logs:
      level: info
  pipelines:
    traces:
      receivers: [otlp]
      processors: [resourcedetection, resource/cx, batch]
      exporters: [otlp]
    metrics:
      receivers: [otlp, awsecscontainermetrics]
      processors: [resourcedetection, resource/cx, batch]
      exporters: [otlp]"""

sidecar_container = {
    "name": "otel-collector",
    "image": "public.ecr.aws/aws-observability/aws-otel-collector:v0.41.2",
    "essential": False,
    "cpu": 128,
    "memory": 256,
    "portMappings": [
        {"containerPort": 4317, "hostPort": 4317, "protocol": "tcp"},
        {"containerPort": 4318, "hostPort": 4318, "protocol": "tcp"}
    ],
    "environment": [
        {"name": "AOT_CONFIG_CONTENT", "value": otel_config}
    ],
    "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
            "awslogs-group": "/ecs/" + data["family"],
            "awslogs-region": "us-east-1",
            "awslogs-stream-prefix": "otel-sidecar"
        }
    }
}

# Modify the app container
app_container = data["containerDefinitions"][0]

# Add mount point for auto-instrumentation
app_container["mountPoints"] = app_container.get("mountPoints", [])
app_container["mountPoints"].append({
    "sourceVolume": "otel-auto-instrumentation",
    "containerPath": "/otel-auto-instrumentation",
    "readOnly": True
})

# Add dependency on init container
app_container["dependsOn"] = [
    {"containerName": "otel-dotnet-init", "condition": "SUCCESS"},
    {"containerName": "otel-collector", "condition": "START"}
]

# Add OTel environment variables
otel_env_vars = [
    {"name": "CORECLR_ENABLE_PROFILING", "value": "1"},
    {"name": "CORECLR_PROFILER", "value": "{918728DD-259F-4A6A-AC2B-B85E1B658318}"},
    {"name": "CORECLR_PROFILER_PATH", "value": "/otel-auto-instrumentation/linux-x64/OpenTelemetry.AutoInstrumentation.Native.so"},
    {"name": "DOTNET_ADDITIONAL_DEPS", "value": "/otel-auto-instrumentation/AdditionalDeps"},
    {"name": "DOTNET_SHARED_STORE", "value": "/otel-auto-instrumentation/store"},
    {"name": "DOTNET_STARTUP_HOOKS", "value": "/otel-auto-instrumentation/net/OpenTelemetry.AutoInstrumentation.StartupHook.dll"},
    {"name": "OTEL_DOTNET_AUTO_HOME", "value": "/otel-auto-instrumentation"},
    {"name": "OTEL_SERVICE_NAME", "value": service_name},
    {"name": "OTEL_EXPORTER_OTLP_ENDPOINT", "value": "http://localhost:4318"},
    {"name": "OTEL_EXPORTER_OTLP_PROTOCOL", "value": "http/protobuf"},
    {"name": "OTEL_RESOURCE_ATTRIBUTES", "value": f"deployment.environment={environment},service.namespace=buxton"},
    {"name": "OTEL_TRACES_EXPORTER", "value": "otlp"},
    {"name": "OTEL_METRICS_EXPORTER", "value": "otlp"},
    {"name": "OTEL_LOGS_EXPORTER", "value": "otlp"}
]

existing_env_names = {e["name"] for e in app_container.get("environment", [])}
for env in otel_env_vars:
    if env["name"] not in existing_env_names:
        app_container["environment"].append(env)

# Add containers: init first, then sidecar, then app (reorder)
data["containerDefinitions"] = [init_container, sidecar_container, app_container]

print(json.dumps(data, indent=2))
')

# Save to file for review
OUTPUT_FILE="/tmp/coralogix-taskdef-${SERVICE_NAME}.json"
echo "${NEW_TASKDEF}" > "${OUTPUT_FILE}"
echo ""
echo "New task definition written to: ${OUTPUT_FILE}"

# Count containers
CONTAINER_COUNT=$(echo "${NEW_TASKDEF}" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['containerDefinitions']))")
echo "Container count: ${CONTAINER_COUNT} (init + sidecar + app)"

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
