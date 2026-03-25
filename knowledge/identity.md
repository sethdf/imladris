# Identity & Access Investigation Runbook

## User Access Issues
1. get_azure_users — check if account enabled, department, manager
2. get_identity_info (Okta) — check user profile, assigned apps
3. Check if user was recently onboarded/offboarded
4. License assignment: check if required M365 licenses are assigned
5. Group membership: check if user is in required security groups

## MFA Issues
1. get_identity_info with include=mfa_factors — list registered factors
2. User locked out: check if MFA device lost/changed
3. MFA bypass: check conditional access policies for exceptions
4. New MFA registration: could be legitimate or attacker persistence
5. SSPR (Self-Service Password Reset): check if enabled for user

## Service Account Alerts
1. Service accounts should not have interactive sign-ins
2. Check if service account password was recently rotated
3. API permissions: check app registrations in Azure AD
4. Client credential flows: check for unusual IP sources
5. Expired client secrets cause application failures

## Password-Related Alerts
1. Multiple failed sign-ins: check if brute force or user error
2. Password spray: many accounts, few attempts each — check patterns
3. Check if password was found in breach database
4. Password expiry: check organization policy settings
5. Self-service reset: verify the reset was initiated by the actual user
