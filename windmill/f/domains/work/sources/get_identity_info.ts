// Windmill Script: Get Identity Info (Read-Only)
// Investigation tool — queries Okta for user details, MFA factors, app assignments, auth events.
// Requires email parameter — never does a full user scan.
//
// Requires Windmill variables:
//   f/investigate/okta_org_url    — e.g., https://buxtonco.okta.com
//   f/investigate/okta_api_token  — SSWS API token

import * as wmill from "windmill-client";

export async function main(
  email: string,
  include: string = "profile,mfa_factors",
) {
  if (!email) return { error: "email is required — this tool never does a full user scan" };

  const orgUrl = await wmill.getVariable("f/investigate/okta_org_url");
  const apiToken = await wmill.getVariable("f/investigate/okta_api_token");

  if (!orgUrl || !apiToken) {
    return { error: "Okta credentials not configured", setup: "Set f/investigate/okta_org_url and f/investigate/okta_api_token" };
  }

  const headers = {
    Authorization: `SSWS ${apiToken}`,
    Accept: "application/json",
  };

  const sections = include.split(",").map(s => s.trim());
  const result: Record<string, any> = {};

  // Find user by email
  const userResp = await fetch(
    `${orgUrl}/api/v1/users?search=${encodeURIComponent(`profile.email eq "${email}"`)}`,
    { headers }
  );
  if (!userResp.ok) return { error: `Okta API error: ${userResp.status}`, body: await userResp.text() };

  const users = await userResp.json();
  if (!users.length) return { error: `No Okta user found for ${email}` };

  const user = users[0];
  const userId = user.id;

  if (sections.includes("profile")) {
    result.profile = {
      id: userId,
      status: user.status,
      first_name: user.profile?.firstName,
      last_name: user.profile?.lastName,
      email: user.profile?.email,
      login: user.profile?.login,
      department: user.profile?.department,
      title: user.profile?.title,
      manager: user.profile?.manager,
      created: user.created,
      last_login: user.lastLogin,
      last_updated: user.lastUpdated,
      password_changed: user.passwordChanged,
    };
  }

  if (sections.includes("mfa_factors")) {
    const mfaResp = await fetch(`${orgUrl}/api/v1/users/${userId}/factors`, { headers });
    if (mfaResp.ok) {
      const factors = await mfaResp.json();
      result.mfa_factors = factors.map((f: any) => ({
        type: f.factorType,
        provider: f.provider,
        status: f.status,
        created: f.created,
        last_updated: f.lastUpdated,
      }));
    }
  }

  if (sections.includes("app_assignments")) {
    const appsResp = await fetch(`${orgUrl}/api/v1/users/${userId}/appLinks`, { headers });
    if (appsResp.ok) {
      const apps = await appsResp.json();
      result.app_assignments = apps.map((a: any) => ({
        app_name: a.appName,
        label: a.label,
        link_url: a.linkUrl,
        sort_order: a.sortOrder,
      }));
    }
  }

  if (sections.includes("auth_events")) {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const eventsResp = await fetch(
      `${orgUrl}/api/v1/logs?filter=${encodeURIComponent(`actor.id eq "${userId}"`)}&since=${since}&limit=20&sortOrder=DESCENDING`,
      { headers }
    );
    if (eventsResp.ok) {
      const events = await eventsResp.json();
      result.auth_events = events.map((e: any) => ({
        timestamp: e.published,
        event_type: e.eventType,
        display_message: e.displayMessage,
        outcome: e.outcome?.result,
        outcome_reason: e.outcome?.reason,
        client_ip: e.client?.ipAddress,
        client_device: e.client?.device,
        client_os: e.client?.operatingSystem,
        client_browser: e.client?.browser,
      }));
    }
  }

  return result;
}
