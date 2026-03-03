// Windmill Script: Get Azure AD Users (Read-Only)
// Investigation tool — queries Azure AD users via Microsoft Graph API.
// Supports filtering by email, department, or name.

import * as wmill from "windmill-client";

export async function main(
  email?: string,
  department?: string,
  name_contains?: string,
  enabled_only: boolean = true,
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

  // Build OData filter
  const filterParts: string[] = [];
  if (email) filterParts.push(`userPrincipalName eq '${email}'`);
  else if (name_contains) filterParts.push(`startswith(displayName,'${name_contains}')`);
  if (department) filterParts.push(`department eq '${department}'`);
  if (enabled_only) filterParts.push("accountEnabled eq true");

  const filter = filterParts.join(" and ");
  const select = "displayName,userPrincipalName,accountEnabled,department,jobTitle,mail,mobilePhone,officeLocation,createdDateTime,lastPasswordChangeDateTime";

  const graphUrl = `https://graph.microsoft.com/v1.0/users?$filter=${encodeURIComponent(filter)}&$select=${select}&$top=${Math.min(limit, 999)}`;

  const graphResp = await fetch(graphUrl, {
    headers: { Authorization: `Bearer ${access_token}` },
  });

  if (!graphResp.ok) {
    return { error: `Graph API error: ${graphResp.status}`, body: await graphResp.text() };
  }

  const data = await graphResp.json();

  return {
    count: data.value?.length || 0,
    users: data.value || [],
  };
}
