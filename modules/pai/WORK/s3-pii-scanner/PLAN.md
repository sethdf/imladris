# S3 PII Scanner - OpenSpec Proposal

## 🟢 Status: READY FOR IMPLEMENTATION

**Last Updated**: 2026-01-22
**Target Bucket**: `buxtonfiles02` (account 945243322929)
**Target Prefix**: `shares/`

### What's Complete
- [x] Architecture designed (S3 Inventory → SQS → Batch/Spot → Presidio → Parquet)
- [x] Cost estimation (updated with actual data below)
- [x] Tech stack selected (Presidio, Fargate Spot, DynamoDB, Parquet)
- [x] OpenSpec-style specification drafted
- [x] IAM cross-account access verified (prod-admin profile)
- [x] Athena tables created for S3 inventory (`pii_scanner.buxtonfiles02_snapshot_202501`)
- [x] File type distribution analyzed from actual inventory data
- [x] S3 Inventory configuration fixed (was broken since Dec 2025, now recreated)

### Pending Before Implementation
- [ ] Wait for new S3 inventory to generate (~24-48 hours)
- [ ] Confirm target AWS account for deployment (945243322929 or separate?)
- [ ] Review file type prioritization with stakeholders

---

## Actual Bucket Statistics (Jan 2025 Snapshot)

| Metric | Value |
|--------|-------|
| **Total Objects** | 7,290,094 |
| **Total Size** | 80.3 TB |
| **Unique Extensions** | 2,301 |
| **Source Bucket** | `buxtonfiles02` |
| **Prefix** | `shares/` |

### File Type Distribution by PII Risk

#### 🔴 High PII Risk (Priority 1 - Scan First)

| Extension | Count | Size | Notes |
|-----------|-------|------|-------|
| **pdf** | 1,110,389 | 1.4 TB | Documents |
| **csv** | 883,371 | 24.5 TB | Data exports |
| **xlsx** | 592,685 | 325 GB | Spreadsheets |
| **doc** | 139,668 | 169 GB | Word docs (legacy) |
| **xls** | 135,633 | 155 GB | Excel (legacy) |
| **docx** | 73,935 | 30 GB | Word docs |
| **txt** | 53,050 | 3.2 TB | Text files |
| **msg** | 19,049 | 7.2 GB | Outlook emails |
| **pst** | 65 | 129 GB | Outlook archives |
| **eml** | 594 | 170 MB | Email files |
| **rtf** | 1,598 | 1.8 GB | Rich text |
| **Subtotal** | **3,010,037** | **~30 TB** | |

#### 🟡 Medium PII Risk (Priority 2)

| Extension | Count | Size | Notes |
|-----------|-------|------|-------|
| **json** | 309,954 | 308 GB | Data files |
| **xml** | 15,604 | 17 GB | Structured data |
| **html/htm** | 99,644 | 13 GB | Web content |
| **sql** | 22,393 | 1.1 GB | Database queries |
| **tsv** | 219 | 47 GB | Tab-separated |
| **jsonl** | 2,458 | 57 GB | JSON lines |
| **Subtotal** | **450,272** | **~443 GB** | |

#### 🟠 Analytics/Data Files (Priority 3 - May contain PII)

| Extension | Count | Size | Notes |
|-----------|-------|------|-------|
| **yxdb** | 744,849 | 19.2 TB | Alteryx databases |
| **sas7bdat** | 12,696 | 3.7 TB | SAS datasets |
| **dbf** | 103,617 | 482 GB | dBase files |
| **parquet** | 10,023 | 2.4 TB | Columnar data |
| **mdb/accdb** | 2,673 | 110 GB | Access databases |
| **dat** | 95,462 | 220 GB | Generic data |
| **sav** | 626 | 58 GB | SPSS files |
| **rdata/rda** | 738 | 35 MB | R data |
| **pkl/pickle** | 2,276 | 381 GB | Python pickles |
| **Subtotal** | **972,960** | **~26 TB** | |

#### 📦 Archives (Priority 4 - Need Decompression)

| Extension | Count | Size | Notes |
|-----------|-------|------|-------|
| **zip** | 40,044 | 3.8 TB | ZIP archives |
| **gz** | 23,837 | 1.0 TB | Gzip compressed |
| **7z** | 673 | 799 GB | 7-Zip archives |
| **rar** | 898 | 101 GB | RAR archives |
| **bz2** | 95 | 465 MB | Bzip2 |
| **Subtotal** | **65,547** | **~5.7 TB** | |

#### 🟢 Low PII Risk (Deprioritize)

| Extension | Count | Size | Notes |
|-----------|-------|------|-------|
| **jpg/jpeg** | 224,711 | 339 GB | Images |
| **png** | 124,994 | 20 GB | Images |
| **gif** | 33,167 | 1.7 GB | Images |
| **py/pyc** | 468,246 | 4.4 GB | Python code |
| **dll/exe** | 34,447 | 195 GB | Binaries |
| **mp3/mp4/mov** | 18,054 | 261 GB | Media |
| **Subtotal** | **903,619** | **~821 GB** | |

#### ⚪ Other/Unknown

| Category | Count | Notes |
|----------|-------|-------|
| No extension | 57,250 | Need content-type detection |
| Rare extensions | ~1,830,409 | 2,200+ other types |

---

## Proposal Overview

**Project**: s3-pii-scanner
**Purpose**: Automated discovery and categorization of PII in S3 buckets at scale (100+ TB, millions of objects with versioning)
**Approach**: Open source, cost-optimized, incremental processing with spot instances

---

## Requirements Specification

### Requirement: Initial Bulk Scan
The system SHALL perform a complete scan of all objects in the target S3 bucket during initial deployment.

#### Scenario: First-time deployment
- GIVEN a bucket with 100+ TB and millions of objects
- WHEN the system is first deployed
- THEN it SHALL use S3 Inventory (not LIST API) to enumerate all objects
- AND queue objects for processing via SQS
- AND process objects using spot instances for cost efficiency

### Requirement: Incremental Processing
The system SHALL detect and process new or modified objects after initial scan.

#### Scenario: New object uploaded
- WHEN a new object is uploaded to the monitored bucket
- THEN S3 Event Notification triggers processing
- AND the object is queued in SQS
- AND processed by the next available worker

#### Scenario: Object version changed
- WHEN a new version of an existing object is created
- THEN the new version is detected and queued
- AND only the new version is scanned (not re-scanning old versions)

### Requirement: PII Detection
The system SHALL detect the following PII categories using Microsoft Presidio:

| Category | Types |
|----------|-------|
| **Standard PII** | SSN, credit cards, emails, phone numbers, names, addresses, DOB |
| **Healthcare/HIPAA** | Medical record numbers, health info, insurance IDs, patient IDs |
| **Financial/PCI** | Bank accounts, routing numbers, IBAN, SWIFT codes |

#### Scenario: PII found in object
- WHEN PII is detected in an object
- THEN a finding record is created with: object key, version ID, PII type, location (offset), confidence score
- AND the finding is written to results storage

### Requirement: State Management
The system SHALL track which objects/versions have been scanned.

#### Scenario: Duplicate prevention
- WHEN an object is queued for processing
- THEN the system checks if that object+version was already processed
- AND skips processing if already scanned (idempotent)

### Requirement: Cost Optimization
The system SHALL minimize operational costs.

#### Scenario: Spot instance interruption
- WHEN a spot instance is interrupted mid-processing
- THEN the job is automatically retried on another instance
- AND no data is lost (checkpointing to S3)

---

## Architecture Design

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           INITIAL SCAN FLOW                             │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌──────────┐    ┌─────────────┐    ┌─────────┐    ┌────────────────┐  │
│  │ S3 Bucket│───▶│ S3 Inventory│───▶│ Lambda  │───▶│ SQS Queue      │  │
│  │ (source) │    │ (daily CSV) │    │ (loader)│    │ (objects)      │  │
│  └──────────┘    └─────────────┘    └─────────┘    └───────┬────────┘  │
│                                                             │           │
│                                                             ▼           │
│                                                    ┌────────────────┐   │
│                                                    │ AWS Batch      │   │
│                                                    │ (Spot workers) │   │
│                                                    │ + Presidio     │   │
│                                                    └───────┬────────┘   │
│                                                             │           │
│                    ┌────────────────┐              ┌────────▼────────┐  │
│                    │ DynamoDB       │◀─────────────│ Results S3      │  │
│                    │ (scan state)   │              │ (Parquet)       │  │
│                    └────────────────┘              └─────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                         INCREMENTAL SCAN FLOW                           │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌──────────┐    ┌─────────────┐    ┌─────────┐    ┌────────────────┐  │
│  │ S3 Bucket│───▶│ S3 Event    │───▶│ SQS     │───▶│ AWS Batch      │  │
│  │ (source) │    │ Notification│    │ Queue   │    │ (Spot workers) │  │
│  └──────────┘    └─────────────┘    └─────────┘    └────────────────┘  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Component Specifications

### 1. S3 Inventory Configuration
- **Schedule**: Daily (for ongoing reconciliation)
- **Format**: CSV (smallest, fastest to parse)
- **Fields**: Bucket, Key, VersionId, Size, LastModified, ETag
- **Destination**: Separate inventory bucket

### 2. Inventory Loader Lambda
- **Trigger**: S3 Event when inventory manifest arrives
- **Function**: Parse inventory CSV, enqueue each object to SQS
- **Batching**: Send 10 messages per SQS batch (max efficiency)
- **Memory**: 1GB (streaming parse, low memory)

### 3. SQS Queue
- **Type**: Standard (order not required)
- **Visibility Timeout**: 15 minutes (match job timeout)
- **Dead Letter Queue**: After 3 retries
- **Message Format**: `{ bucket, key, versionId, size }`

### 4. AWS Batch Compute Environment
- **Type**: Managed, Fargate Spot (simplest, serverless)
- **Alternative**: EC2 Spot for higher throughput (m6i.large)
- **vCPU**: 1-256 (auto-scale based on queue depth)
- **Memory**: 2GB per job (Presidio + NLP model)

### 5. Scanner Worker (Docker Container)
- **Base**: python:3.11-slim
- **Dependencies**: presidio-analyzer, presidio-anonymizer, boto3, spacy
- **NLP Model**: en_core_web_lg (best accuracy for NER)
- **Compression Support**: gzip, zip, tar, tar.gz (decompress before scanning)
- **Logic**:
  1. Pull message from SQS
  2. Check DynamoDB if already processed
  3. Download object from S3 (stream for large files)
  4. Detect compression, decompress if needed (gzip, zip, tar)
  5. For archives (zip/tar): scan each contained file
  6. Run Presidio analyzer on text content
  7. Write findings to S3 (Parquet)
  8. Mark as processed in DynamoDB
  9. Delete SQS message

### 6. DynamoDB State Table
- **Table**: `pii-scanner-state`
- **Partition Key**: `bucket#key`
- **Sort Key**: `versionId`
- **Attributes**: `scannedAt`, `findingCount`, `status`
- **Billing**: On-demand (pay per request, cheap at rest)

### 7. Results Storage (S3)
- **Format**: Parquet (compressed, Athena-queryable)
- **Partitioning**: `s3://results/year=YYYY/month=MM/day=DD/`
- **Schema**:
  ```
  bucket: string
  key: string
  versionId: string
  piiType: string (e.g., "CREDIT_CARD", "SSN", "EMAIL")
  confidence: float
  location: struct { start: int, end: int }
  scannedAt: timestamp
  ```

### 8. S3 Event Notification (Incremental)
- **Events**: `s3:ObjectCreated:*`
- **Destination**: Same SQS queue as batch jobs
- **Filter**: Optional prefix/suffix filters

---

## Cost Estimation (Updated with Actual Data)

### Initial Scan (80.3 TB, 7.3M objects - Priority 1+2 files only: ~3.5M files, ~30 TB)

| Component | Calculation | Cost |
|-----------|-------------|------|
| S3 Inventory | 7.3M objects × $0.0025/M | $0.02 |
| S3 GET requests | 3.5M × $0.0004/1K | $1.40 |
| Data transfer (within region) | Free | $0 |
| Fargate Spot (2GB, 30s avg) | 3.5M × 0.5min × $0.000017/min | ~$30 |
| DynamoDB writes | 3.5M × $1.25/M | $4.40 |
| SQS | 3.5M messages × $0.40/M | $1.40 |
| **Total Initial Scan (Priority 1+2)** | | **~$40** |

### Full Scan (all 7.3M objects)

| Component | Calculation | Cost |
|-----------|-------------|------|
| S3 GET requests | 7.3M × $0.0004/1K | $2.92 |
| Fargate Spot (2GB, 30s avg) | 7.3M × 0.5min × $0.000017/min | ~$62 |
| DynamoDB writes | 7.3M × $1.25/M | $9.12 |
| SQS | 7.3M messages × $0.40/M | $2.92 |
| **Total Full Scan** | | **~$80** |

### Ongoing Monthly (assuming 100K new objects/month)

| Component | Calculation | Cost |
|-----------|-------------|------|
| S3 Inventory (daily) | 30 × $0.02 | $0.60 |
| S3 GET requests | 100K × $0.0004/1K | $0.04 |
| Fargate Spot | 100K × 0.5min × $0.000017 | $0.85 |
| DynamoDB | 100K writes + reads | ~$0.50 |
| SQS | 100K messages | $0.04 |
| **Total Monthly** | | **~$2/month** |

*Note: Costs are significantly lower than original estimates because actual object count (7.3M) is much smaller than assumed (100M).*

---

## Repository Setup

- **Location**: New repository `s3-pii-scanner`
- **Compression**: Full support for gzip, zip, tar, tar.gz
- **IaC**: Greenfield Terraform (no existing state to integrate)

## File Structure

```
s3-pii-scanner/
├── README.md
├── infrastructure/
│   ├── main.tf                    # Terraform root module
│   ├── variables.tf               # Input variables
│   ├── outputs.tf                 # Output values
│   ├── modules/
│   │   ├── s3-inventory/          # Inventory configuration
│   │   ├── sqs/                   # Queue setup
│   │   ├── batch/                 # AWS Batch compute env
│   │   ├── dynamodb/              # State table
│   │   └── lambda/                # Inventory loader
├── scanner/
│   ├── Dockerfile                 # Scanner container
│   ├── requirements.txt           # Python deps
│   ├── scanner.py                 # Main scanner logic
│   ├── presidio_config.py         # PII recognizers config
│   └── tests/
│       └── test_scanner.py
├── lambda/
│   ├── inventory_loader/
│   │   ├── handler.py             # Lambda function
│   │   └── requirements.txt
└── scripts/
    ├── deploy.sh                  # Deployment script
    ├── trigger-initial-scan.sh    # Start bulk scan
    └── query-findings.sql         # Athena query examples
```

---

## Implementation Tasks

- [ ] **Phase 1: Infrastructure Setup**
  - [ ] Create Terraform module structure
  - [ ] Configure S3 Inventory on source bucket
  - [ ] Set up SQS queue with DLQ
  - [ ] Create DynamoDB state table
  - [ ] Set up AWS Batch compute environment (Fargate Spot)

- [ ] **Phase 2: Scanner Development**
  - [ ] Create Dockerfile with Presidio + spaCy
  - [ ] Implement scanner.py with PII detection logic
  - [ ] Add HIPAA and financial recognizers to Presidio
  - [ ] Implement checkpointing for large files
  - [ ] Write unit tests

- [ ] **Phase 3: Lambda & Integration**
  - [ ] Create inventory loader Lambda
  - [ ] Set up S3 event notification for incremental
  - [ ] Configure IAM roles with least privilege
  - [ ] Set up CloudWatch alarms for DLQ depth

- [ ] **Phase 4: Results & Querying**
  - [ ] Configure Parquet output to S3
  - [ ] Create Athena table for findings
  - [ ] Write example queries

- [ ] **Phase 5: Testing & Deployment**
  - [ ] Test with small bucket first
  - [ ] Validate PII detection accuracy
  - [ ] Run initial scan
  - [ ] Monitor and tune

---

## Verification Plan

1. **Unit tests**: Run `pytest scanner/tests/` for PII detection accuracy
2. **Integration test**: Deploy to dev, scan test bucket with known PII samples
3. **Validate findings**: Query Athena, verify expected PII types detected
4. **Cost verification**: Check AWS Cost Explorer after initial scan
5. **Spot interruption test**: Manually terminate instance, verify retry works

---

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| PII Engine | Microsoft Presidio | Open source, extensible, supports custom recognizers |
| Compute | Fargate Spot | Simplest management, no EC2 to patch, 70% savings |
| State Store | DynamoDB | Serverless, scales to billions, cheap at rest |
| Results Format | Parquet | Compressed, columnar, Athena-native |
| IaC | Terraform | Standard, reusable modules |
| Change Detection | S3 Events + Daily Inventory | Events for real-time, inventory for reconciliation |

---

## Athena Infrastructure (Already Created)

### Database
- **Database**: `pii_scanner` (in account 945243322929, us-east-1)

### Tables

#### `pii_scanner.buxtonfiles02_inventory`
- **Description**: All historical inventory snapshots (multiple days)
- **Location**: `s3://buxtonfiles02/buxtonfiles02/All_Shares_Current_Objects/data/`
- **Use**: Historical analysis, but counts are inflated (same object appears multiple times)

#### `pii_scanner.buxtonfiles02_snapshot_202501`
- **Description**: Single snapshot from Jan 30, 2025
- **Location**: `s3://buxtonfiles02/buxtonfiles02/All_Shares_Current_Objects/hive/dt=2025-01-30-01-00/`
- **Use**: Accurate current-state analysis (7.3M objects, 80.3 TB)

### Example Queries

```sql
-- File type distribution
SELECT
  LOWER(REGEXP_EXTRACT(key, '\\.([^./]+)$', 1)) as extension,
  COUNT(*) as count,
  SUM(CAST(COALESCE(NULLIF(size,''), '0') AS BIGINT)) as total_bytes
FROM pii_scanner.buxtonfiles02_snapshot_202501
GROUP BY LOWER(REGEXP_EXTRACT(key, '\\.([^./]+)$', 1))
ORDER BY count DESC;

-- High-risk files only
SELECT key, size, last_modified_date
FROM pii_scanner.buxtonfiles02_snapshot_202501
WHERE LOWER(key) LIKE '%.csv'
   OR LOWER(key) LIKE '%.xlsx'
   OR LOWER(key) LIKE '%.pdf'
   OR LOWER(key) LIKE '%.doc%'
   OR LOWER(key) LIKE '%.msg';
```

### S3 Inventory Status
- **Configuration**: Recreated 2026-01-22 (was broken since Dec 15, 2025)
- **Schedule**: Daily
- **Expected**: New inventory within 24-48 hours

### Athena Query IDs (for reproducibility)

| Query | ID | Result |
|-------|-----|--------|
| Create database | `9cefec11-7c51-4f25-a040-2cbd3241ae28` | SUCCESS |
| Create inventory table | `1f2351bf-1102-4b56-a484-e4cbbb20f6b2` | SUCCESS |
| Create snapshot table | `c25eabae-fff5-4122-9d58-4607307f39e8` | SUCCESS |
| Total object count | `37f6eadd-e4ca-46f0-948c-4ce4dc8e22f2` | 7,290,094 objects |
| Unique extensions | `03aaab3d-02e4-4178-a440-91d95fea64eb` | 2,301 types |
| File type distribution | `2cc858ec-461e-4cad-a012-ec29dbe36e8b` | Full breakdown |

To retrieve results: `aws athena get-query-results --query-execution-id <ID> --region us-east-1 --profile prod-admin`

---

## Changelog

| Date | Change | Details |
|------|--------|---------|
| 2026-01-22 | Status → READY | IAM access verified, blockers resolved |
| 2026-01-22 | Athena tables created | `pii_scanner.buxtonfiles02_inventory`, `pii_scanner.buxtonfiles02_snapshot_202501` |
| 2026-01-22 | File type analysis | Analyzed 2,301 extensions from Jan 2025 snapshot |
| 2026-01-22 | S3 Inventory fixed | Recreated config (was broken since Dec 15, 2025) |
| 2026-01-22 | Cost estimates revised | $40-80 (was $1,100) based on actual 7.3M objects |
| 2026-01-22 | Initial draft | Architecture, requirements, cost estimation |

---

## Sources

- [Microsoft Presidio](https://github.com/microsoft/presidio) - PII detection framework
- [OpenSpec](https://github.com/Fission-AI/OpenSpec) - Spec-driven development
- [AWS S3 Inventory](https://docs.aws.amazon.com/AmazonS3/latest/userguide/storage-inventory.html) - Cost-effective object enumeration
- [AWS Batch with Spot](https://aws.amazon.com/blogs/compute/cost-effective-batch-processing-with-amazon-ec2-spot/) - Spot instance patterns
- [Project Matt](https://github.com/OElesin/project-matt) - Reference S3 PII scanner architecture
