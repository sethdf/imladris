# Security Investigation Runbook

## Suspicious Sign-In Activity
1. get_azure_sign_ins for the user — check location, device, IP
2. Impossible travel: sign-ins from distant locations within short time
3. Check if sign-in from known corporate IP ranges (VPN, office)
4. Check MFA status: was MFA prompted and satisfied?
5. Legacy auth protocols (IMAP, POP3) bypass MFA — check appDisplayName
6. Risky sign-ins: check Azure AD Identity Protection risk level

## Account Compromise Indicators
1. get_azure_users — check if account is still enabled
2. get_identity_info (Okta) — check MFA factors, recent events
3. Look for password reset events close to suspicious activity
4. Check if new MFA factor was registered (attacker persistence)
5. Check mailbox rules — forwarding to external address is compromise indicator
6. Check Azure AD audit logs for role/permission changes

## Security Group Changes
1. get_security_groups — identify overly permissive rules (0.0.0.0/0)
2. get_cloudtrail_events — who made the change and when
3. Port 22/3389 open to internet: immediate risk, verify intentional
4. Any rule allowing all traffic (protocol -1): high risk
5. Check if change was part of a deployment or ad-hoc

## Securonix SIEM Alerts
1. get_security_events incidents — get incident details
2. Check violation details for specific user/entity activity
3. Correlate with Azure AD sign-ins for the same timeframe
4. Check if the activity matches known business patterns
5. Threat intelligence: check if source IPs are in known bad lists

## Device Compliance Issues
1. get_azure_devices — check compliance state, OS version
2. Non-compliant devices: check which policies are failing
3. Stale devices: not seen in 30+ days, may need cleanup
4. Unmanaged devices: personal devices accessing corporate resources
5. Check Intune enrollment status if device should be managed
