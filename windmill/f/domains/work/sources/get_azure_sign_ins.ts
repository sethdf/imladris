// Windmill Script: Get Azure AD Sign-Ins (Read-Only)
// Investigation tool — queries Azure AD sign-in logs via Microsoft Graph API.
// REQUIRES user_email parameter — never does a full scan of all sign-ins.

import * as wmill from "windmill-client";

export async function main(
  user_email: string,
  hours_back: number = 24,
  status_filter?: "success" | "failure" | "interrupted",
  limit: number = 50,
) {
  if (!user_email) {
    return { error: "user_email is required — this tool never does a full sign-in scan" };
  }

  const tenantId = await wmill.getVariable("f/devops/m365_tenant_id");
  const clientId = await wmill.getVariable("f/devops/m365_client_id");
  const clientSecret = await wmill.getVariable("f/devops/m365_client_secret");

  const tokenResp = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }),
    }
  );

  if (!tokenResp.ok) {
    return { error: `OAuth token request failed: ${tokenResp.status}`, body: await tokenResp.text() };
  }

  const { access_token } = await tokenResp.json();

  const since = new Date(Date.now() - hours_back * 60 * 60 * 1000).toISOString();
  const filterParts = [
    `userPrincipalName eq '${user_email}'`,
    `createdDateTime ge ${since}`,
  ];

  if (status_filter === "success") filterParts.push("status/errorCode eq 0");
  else if (status_filter === "failure") filterParts.push("status/errorCode ne 0");

  const filter = filterParts.join(" and ");
  const select = "createdDateTime,userPrincipalName,appDisplayName,ipAddress,clientAppUsed,location,status,deviceDetail,riskDetail,riskLevelDuringSignIn,conditionalAccessStatus";

  const graphUrl = `https://graph.microsoft.com/v1.0/auditLogs/signIns?$filter=${encodeURIComponent(filter)}&$select=${select}&$top=${Math.min(limit, 999)}&$orderby=createdDateTime desc`;

  const graphResp = await fetch(graphUrl, {
    headers: { Authorization: `Bearer ${access_token}` },
  });

  if (!graphResp.ok) {
    return { error: `Graph API error: ${graphResp.status}`, body: await graphResp.text() };
  }

  const data = await graphResp.json();

  return {
    user: user_email,
    hours_back,
    count: data.value?.length || 0,
    sign_ins: (data.value || []).map((s: any) => ({
      timestamp: s.createdDateTime,
      app: s.appDisplayName,
      ip: s.ipAddress,
      client: s.clientAppUsed,
      city: s.location?.city,
      country: s.location?.countryOrRegion,
      status_code: s.status?.errorCode,
      failure_reason: s.status?.failureReason,
      device_os: s.deviceDetail?.operatingSystem,
      device_browser: s.deviceDetail?.browser,
      risk_level: s.riskLevelDuringSignIn,
      conditional_access: s.conditionalAccessStatus,
    })),
  };
}
