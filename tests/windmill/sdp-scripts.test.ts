import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('entity_extract', () => {
  let tempHome: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'entity-extract-test-'));
    mkdirSync(join(tempHome, '.claude', 'logs'), { recursive: true });
    origHome = process.env.HOME;
    process.env.HOME = tempHome;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(tempHome, { recursive: true, force: true });
  });

  test('finds AWS instance IDs in payload', async () => {
    // Import fresh each time since module caches HOME
    // Use dynamic import to get fresh module state
    const mod = await import('../../windmill/f/devops/entity_extract');
    const result = await mod.main(
      'Instance i-0ba6d18abd66116a4 is running in account 767448074758',
      'test',
      false, // skip steampipe enrichment
    );

    expect(result.entity_count).toBeGreaterThanOrEqual(1);
    const instanceEntity = result.entities.find((e: any) => e.type === 'aws_instance');
    expect(instanceEntity).toBeTruthy();
    expect(instanceEntity!.value).toBe('i-0ba6d18abd66116a4');
  });

  test('finds CVE patterns', async () => {
    const mod = await import('../../windmill/f/devops/entity_extract');
    const result = await mod.main(
      'Critical vulnerability CVE-2024-12345 and CVE-2025-67890 found in production',
      'test',
      false,
    );

    const cves = result.entities.filter((e: any) => e.type === 'cve');
    expect(cves.length).toBe(2);
    expect(cves.map((c: any) => c.value).sort()).toEqual(['CVE-2024-12345', 'CVE-2025-67890']);
  });

  test('deduplicates entities', async () => {
    const mod = await import('../../windmill/f/devops/entity_extract');
    const result = await mod.main(
      'Instance i-0abc1234 mentioned here and i-0abc1234 mentioned again',
      'test',
      false,
    );

    const instances = result.entities.filter((e: any) => e.type === 'aws_instance');
    expect(instances.length).toBe(1);
  });

  test('returns error when payload is empty', async () => {
    const mod = await import('../../windmill/f/devops/entity_extract');
    const result = await mod.main('', 'test', false);
    expect(result.error).toBe('payload is required');
  });

  test('types_found contains unique entity types', async () => {
    const mod = await import('../../windmill/f/devops/entity_extract');
    const result = await mod.main(
      'Instance i-0abc1234 in vpc-deadbeef with CVE-2024-99999',
      'test',
      false,
    );

    expect(result.types_found).toContain('aws_instance');
    expect(result.types_found).toContain('aws_vpc');
    expect(result.types_found).toContain('cve');
    // Each type only appears once
    const uniqueCount = new Set(result.types_found).size;
    expect(uniqueCount).toBe(result.types_found.length);
  });
});

describe('list_tickets', () => {
  test('returns error when WM_TOKEN is not set', async () => {
    // Save and clear relevant env vars
    const origToken = process.env.WM_TOKEN;
    const origBase = process.env.BASE_INTERNAL_URL;
    delete process.env.WM_TOKEN;
    delete process.env.BASE_INTERNAL_URL;

    try {
      const mod = await import('../../windmill/f/devops/list_tickets');
      const result = await mod.main();

      expect(result.error).toBe('SDP credentials not configured');
      expect(result.setup).toBeTruthy();
    } finally {
      if (origToken) process.env.WM_TOKEN = origToken;
      if (origBase) process.env.BASE_INTERNAL_URL = origBase;
    }
  });

  test('formats response correctly with mock data', async () => {
    // Mock fetch globally to simulate Windmill variable API + SDP API
    const originalFetch = globalThis.fetch;
    let fetchCallCount = 0;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      fetchCallCount++;

      // Windmill variable API calls
      if (url.includes('/variables/get_value/f/devops/sdp_base_url')) {
        return new Response('"https://sdpondemand.manageengine.com/app/itdesk/api/v3"', { status: 200 });
      }
      if (url.includes('/variables/get_value/f/devops/sdp_api_key')) {
        return new Response('"mock-api-key-12345"', { status: 200 });
      }

      // SDP API call
      if (url.includes('sdpondemand.manageengine.com')) {
        return new Response(JSON.stringify({
          requests: [
            {
              id: 101,
              subject: 'Test Ticket',
              status: { name: 'Open' },
              priority: { name: 'High' },
              technician: { name: 'Seth' },
              created_time: { display_value: '2026-02-24 10:00' },
            },
            {
              id: 102,
              subject: 'Another Ticket',
              status: { name: 'In Progress' },
              priority: { name: 'Medium' },
              technician: { name: 'Seth' },
              created_time: { display_value: '2026-02-24 11:00' },
            },
          ],
        }), { status: 200 });
      }

      return originalFetch(input, init);
    }) as typeof fetch;

    // Set env vars for Windmill internal API
    const origToken = process.env.WM_TOKEN;
    const origBase = process.env.BASE_INTERNAL_URL;
    process.env.WM_TOKEN = 'test-token';
    process.env.BASE_INTERNAL_URL = 'http://localhost:8000';

    try {
      const mod = await import('../../windmill/f/devops/list_tickets');
      const result = await mod.main();

      expect(result.count).toBe(2);
      expect(result.tickets[0].subject).toBe('Test Ticket');
      expect(result.tickets[0].status).toBe('Open');
      expect(result.tickets[1].subject).toBe('Another Ticket');
    } finally {
      globalThis.fetch = originalFetch;
      if (origToken) process.env.WM_TOKEN = origToken; else delete process.env.WM_TOKEN;
      if (origBase) process.env.BASE_INTERNAL_URL = origBase; else delete process.env.BASE_INTERNAL_URL;
    }
  });
});
