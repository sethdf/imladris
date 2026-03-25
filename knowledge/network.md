# Network Investigation Runbook

## DNS Resolution Failures
1. check_network dns_lookup — verify A/AAAA records exist
2. Check if domain expired (WHOIS via check_network)
3. Check if DNS propagation incomplete (recently changed)
4. Internal DNS: check Route 53 private hosted zones in correct VPC
5. Split-horizon: public vs private resolution may differ

## TLS Certificate Issues
1. check_network check_certificate — get expiry, issuer, SAN list
2. Certificate expired: check ACM auto-renewal status
3. Certificate mismatch: compare requested hostname vs SAN/CN
4. Chain incomplete: intermediate certificates missing
5. ACM certificates auto-renew if DNS validation record exists
6. Self-signed certificates on internal services: check if expected

## Email Delivery Issues
1. check_network mx_lookup — verify MX records point to correct mail servers
2. check_network txt_lookup — verify SPF record includes sending IPs
3. DKIM: check TXT records for selector._domainkey
4. DMARC: check _dmarc TXT record for policy
5. Bounce messages: check if recipient domain has valid MX
6. Buxton uses Microsoft 365 — MX should point to *.mail.protection.outlook.com

## Connectivity Failures
1. DNS resolves but connection fails: check security groups, NACLs
2. Timeout vs refused: timeout = network block, refused = service not listening
3. Check if Tailscale route is needed for internal resources
4. VPC peering: check route tables in both VPCs
5. NAT Gateway: check if private subnet instances can reach internet

## Site24x7 Monitor Alerts
1. DOWN alert: verify with direct check_network dns_lookup + check_certificate
2. May be false positive: check from multiple locations
3. SSL monitor alerts: usually certificate approaching expiry
4. URL monitor: check HTTP status code and response time
