// Windmill Script: Get Azure AD Devices (Read-Only)
// Investigation tool — queries Azure AD devices via Microsoft Graph API.
// Returns device compliance status, OS info, and ownership.

import * as wmill from "windmill-client";

export async function main(
  display_name_contains?: string,
  os_type?: string,
  is_compliant?: boolean,
  limit: number = 50,
) {
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

  const filterParts: string[] = [];
  if (display_name_contains) filterParts.push(`startswith(displayName,'${display_name_contains}')`);
  if (os_type) filterParts.push(`operatingSystem eq '${os_type}'`);
  if (is_compliant !== undefined) filterParts.push(`isCompliant eq ${is_compliant}`);

  const filter = filterParts.join(" and ");
  const select = "displayName,deviceId,operatingSystem,operatingSystemVersion,isCompliant,isManaged,trustType,registeredOwners,approximateLastSignInDateTime,accountEnabled";

  const graphUrl = `https://graph.microsoft.com/v1.0/devices?${filter ? `$filter=${encodeURIComponent(filter)}&` : ""}$select=${select}&$top=${Math.min(limit, 999)}`;

  const graphResp = await fetch(graphUrl, {
    headers: { Authorization: `Bearer ${access_token}` },
  });

  if (!graphResp.ok) {
    return { error: `Graph API error: ${graphResp.status}`, body: await graphResp.text() };
  }

  const data = await graphResp.json();

  return {
    count: data.value?.length || 0,
    devices: (data.value || []).map((d: any) => ({
      display_name: d.displayName,
      device_id: d.deviceId,
      os: d.operatingSystem,
      os_version: d.operatingSystemVersion,
      is_compliant: d.isCompliant,
      is_managed: d.isManaged,
      trust_type: d.trustType,
      last_sign_in: d.approximateLastSignInDateTime,
      enabled: d.accountEnabled,
    })),
  };
}
