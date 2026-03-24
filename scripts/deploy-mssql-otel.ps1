param(
    [Parameter(Mandatory=$true)]
    [string]$HostName,

    [Parameter(Mandatory=$false)]
    [string]$InstanceName = "",

    [Parameter(Mandatory=$false)]
    [string]$Environment = "production"
)

$ErrorActionPreference = "Stop"
$OtelVersion = "0.120.1"
$OtelDir = "C:\otel"
$ConfigPath = "$OtelDir\config.yaml"
$ServiceName = "otelcol-contrib"
$DownloadUrl = "https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v${OtelVersion}/otelcol-contrib_${OtelVersion}_windows_amd64.tar.gz"
$TarPath = "$OtelDir\otelcol-contrib.tar.gz"
$IngestionKey = "84yQjHlEAqt1HClWu4vW9qLK7ZeVSuDiIZeG"

Write-Output "=== Deploying OTel MSSQL monitoring to $HostName ==="
if ($InstanceName) { Write-Output "Named instance: $InstanceName" }

# Check if service already exists and is running
$existingSvc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existingSvc -and $existingSvc.Status -eq "Running") {
    Write-Output "OTel Collector service already running. Skipping deployment."
    exit 0
}

# Create directory
if (-not (Test-Path $OtelDir)) {
    New-Item -ItemType Directory -Path $OtelDir -Force | Out-Null
    Write-Output "Created $OtelDir"
}

# Check disk space (need at least 500MB free)
$drive = (Get-PSDrive C)
$freeGB = [math]::Round($drive.Free / 1GB, 1)
Write-Output "Free disk space on C: ${freeGB}GB"
if ($drive.Free -lt 500MB) {
    Write-Error "Insufficient disk space: ${freeGB}GB free, need at least 0.5GB"
    exit 1
}

# Download otelcol-contrib if not already present
if (-not (Test-Path "$OtelDir\otelcol-contrib.exe")) {
    Write-Output "Downloading otelcol-contrib v${OtelVersion}..."
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    try {
        Invoke-WebRequest -Uri $DownloadUrl -OutFile $TarPath -UseBasicParsing
        Write-Output "Download complete. Extracting..."
        tar -xzf $TarPath -C $OtelDir
        Remove-Item $TarPath -Force
        Write-Output "Extraction complete."
    } catch {
        Write-Error "Download failed: $_"
        exit 1
    }
} else {
    Write-Output "otelcol-contrib.exe already exists, skipping download."
}

# Verify binary exists
if (-not (Test-Path "$OtelDir\otelcol-contrib.exe")) {
    Write-Error "otelcol-contrib.exe not found after extraction"
    exit 1
}

# Build sqlserver receiver config
if ($InstanceName) {
    $receiverConfig = @"
  sqlserver:
    collection_interval: 30s
    instance_name: $InstanceName
    resource_attributes:
      sqlserver.computer.name:
        enabled: true
      sqlserver.instance.name:
        enabled: true
"@
} else {
    $receiverConfig = @"
  sqlserver:
    collection_interval: 30s
"@
}

# Write config
$config = @"
receivers:
$receiverConfig
processors:
  batch:
    send_batch_size: 100
    timeout: 10s
  resource:
    attributes:
      - key: signoz.collector.type
        value: mssql-monitor
        action: upsert
      - key: host.name
        value: $HostName
        action: upsert
      - key: deployment.environment
        value: $Environment
        action: upsert
exporters:
  otlphttp:
    endpoint: https://ingest.us.signoz.cloud
    headers:
      signoz-ingestion-key: $IngestionKey
service:
  telemetry:
    logs:
      level: info
  pipelines:
    metrics:
      receivers: [sqlserver]
      processors: [resource, batch]
      exporters: [otlphttp]
"@

Set-Content -Path $ConfigPath -Value $config -Encoding UTF8
Write-Output "Config written to $ConfigPath"

# Register Windows service if not exists
if (-not (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)) {
    Write-Output "Registering Windows service..."
    sc.exe create $ServiceName binPath= "$OtelDir\otelcol-contrib.exe --config=$ConfigPath" start= auto DisplayName= "OpenTelemetry Collector"
    sc.exe description $ServiceName "OTel Collector - MSSQL metrics to SigNoz"
    Write-Output "Service registered."
}

# Start service
Write-Output "Starting service..."
Start-Service -Name $ServiceName
Start-Sleep -Seconds 5

# Verify service is running
$svc = Get-Service -Name $ServiceName
Write-Output "Service status: $($svc.Status)"
if ($svc.Status -ne "Running") {
    Write-Error "Service failed to start"
    exit 1
}

# Get process info
$proc = Get-Process -Name otelcol-contrib -ErrorAction SilentlyContinue
if ($proc) {
    $memMB = [math]::Round($proc.WorkingSet64 / 1MB, 0)
    Write-Output "Process PID: $($proc.Id), Memory: ${memMB}MB"
}

Write-Output "=== Deployment complete for $HostName ==="
