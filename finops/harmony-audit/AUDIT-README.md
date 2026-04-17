Harmony SASE Audit - Pre-VPN-Change Snapshot
Timestamp: 2026-04-16T23:31:32Z
Purpose: Rollback reference before adding AWSFinance tunnel to buxnet01

Files:
  networks-full.json — All 4 networks with gateways, instances, tunnels
  groups-full.json — All 21 groups
  users-full.json — All users (PII — do not commit to public repos)
  buxnet01-pre-change.json — buxnet01 network detail before tunnel addition

Existing buxnet01 tunnels:
  AWSprd (VbtbkafmVG) — Dallas 131.226.43.89 → AWS Prod 34.237.68.18

SHA256 hashes:
743bf8140ed7c5e15bc86f4fee7d37b5526ec869e2fd9500a491c73b8c3e9093  /home/ec2-user/repos/imladris/finops/harmony-audit/buxnet01-pre-change.json
26773c7f1ad9f669afb66567258642fddd6bfe58db17595b90c7589e1651cc53  /home/ec2-user/repos/imladris/finops/harmony-audit/groups-full.json
2899a6c9d401687e98fd8af15f5f1b074b4c382f0940877814403a6791a368bd  /home/ec2-user/repos/imladris/finops/harmony-audit/networks-full.json
0d11de801a52b3b9eba8177de82fbdf940c8fd52696d0d0abdc9c5a4aa69da8e  /home/ec2-user/repos/imladris/finops/harmony-audit/users-full.json

=== POST-CHANGE (2026-04-16T23:38:40Z) ===
Added tunnel: AWSFinance (gCvxfF2V5o) on buxnet01 Dallas → AWS Finance VGW 32.194.202.224
Existing AWSprd tunnel: UNCHANGED (updatedAt still 2026-02-02T14:24:46.871Z)

Rollback: DELETE https://api.perimeter81.com/api/rest/v2/networks/ZmvelR4yMK/tunnels/ipsec/single/gCvxfF2V5o
