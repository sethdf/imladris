# AWS Investigation Runbook

## EC2 Instance Down/Unreachable
1. Check CloudTrail for StopInstances/TerminateInstances — determines if planned or crash
2. Check CloudWatch StatusCheckFailed — distinguishes host vs instance failure
3. If StatusCheckFailed_System: AWS hardware issue, instance may auto-recover or need stop/start
4. If StatusCheckFailed_Instance: OS-level crash, check system logs via get_cloudwatch_metrics
5. Check security group rules — was access accidentally revoked?
6. Check VPC flow logs if network connectivity suspected

## RDS Issues
1. Check CloudWatch for FreeStorageSpace, CPUUtilization, DatabaseConnections
2. Low storage: check if auto-scaling enabled, identify largest tables
3. High CPU: check slow query log, active connections count
4. Connection failures: check security groups, subnet routing, DNS resolution
5. Multi-AZ failover: check events, may cause brief outage

## ECS Service Unhealthy
1. Check service events for deployment failures or task placement errors
2. Check task definitions — image pull failures indicate ECR or networking issues
3. Check target group health — deregistration means health check failing
4. Check container logs via CloudWatch Logs group
5. Common: insufficient memory/CPU → OOM kill → check task metrics

## Lambda Errors
1. Check CloudWatch Logs for the function
2. Timeout errors: check duration vs configured timeout
3. Throttling: check concurrent execution limits
4. Permission errors: check execution role policies
5. Cold start issues: check provisioned concurrency settings

## S3 Access Issues
1. Check bucket policy + IAM policy intersection
2. 403 errors: bucket policy deny overrides IAM allow
3. Check if bucket is in a different region than expected
4. Check if encryption key (KMS) access is configured
5. Public access block settings may prevent intended access

## Cross-Account Access
BuxtonIT org has 16 accounts. ImladrisReadOnly role deployed via StackSet.
If access fails: check if StackSet deployment succeeded in that account, verify trust policy.
Management account (751182152181) has manual roles — StackSet skips it.
