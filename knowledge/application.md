# Application Investigation Runbook

## SDP Ticket Patterns
1. get_sdp_tickets — search for related tickets by keyword
2. Check if similar issue was reported recently (pattern detection)
3. Check ticket requester history — repeat issues suggest systemic problem
4. Check if there's a known change/deployment correlating with the issue
5. SDP closure requires: resolution, ticket_approved (N/A or Yes), time_spent

## Vendor/Third-Party Issues
1. query_vendors — check vendor criticality and contact info
2. Vendor service degradation: check vendor status page
3. API integration failures: check if API keys expired
4. check_network check_certificate — verify vendor endpoint TLS
5. DNS changes by vendor can break integrations

## Monitoring False Positives
1. get_monitoring_alerts — check monitor history and frequency
2. Repeated DOWN/UP cycles: likely threshold too sensitive
3. Check if maintenance window was scheduled
4. URL monitors: check if response changed (content match failure)
5. Server monitors: check if agent needs update

## Deployment/Change Related
1. Correlate alert timing with recent deployments (CloudTrail)
2. ECS deployments: check task definition changes
3. Lambda: check if function code was recently updated
4. Config changes: check CloudTrail for ModifyDBInstance, UpdateService, etc.
5. Rollback indicators: rapid succession of deployment events
