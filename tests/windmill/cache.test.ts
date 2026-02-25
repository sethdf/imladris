// cache.test.ts — Tests for the NVMe triage cache library
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Set CACHE_DIR to a temp directory before importing cache_lib
const testDir = mkdtempSync(join(tmpdir(), "cache-test-"));
process.env.CACHE_DIR = testDir;

// Dynamic import after setting env
const cacheLib = await import("../../windmill/f/devops/cache_lib.ts");
const { init, store, queryEntity, search, recent, stats, evict, extractEntities, isAvailable, getRaw } = cacheLib;

describe("cache_lib", () => {
  beforeEach(() => {
    // Clean and reinit for each test
    try { rmSync(testDir, { recursive: true }); } catch {}
    process.env.CACHE_DIR = mkdtempSync(join(tmpdir(), "cache-test-"));
  });

  afterEach(() => {
    try { rmSync(process.env.CACHE_DIR!, { recursive: true }); } catch {}
  });

  describe("init", () => {
    test("creates database and tables", () => {
      const result = init();
      expect(result).toBe(true);
      expect(existsSync(join(process.env.CACHE_DIR!, "index.db"))).toBe(true);
    });
  });

  describe("extractEntities", () => {
    test("extracts instance IDs", () => {
      const entities = extractEntities("Instance i-0ba6d18abd66116a4 is running");
      expect(entities).toContainEqual({ entity: "i-0ba6d18abd66116a4", type: "instance" });
    });

    test("extracts security groups", () => {
      const entities = extractEntities("sg-12345678 allows all traffic");
      expect(entities).toContainEqual({ entity: "sg-12345678", type: "sg" });
    });

    test("extracts CVEs", () => {
      const entities = extractEntities("Patched CVE-2025-12345 yesterday");
      expect(entities).toContainEqual({ entity: "CVE-2025-12345", type: "cve" });
    });

    test("extracts IPs", () => {
      const entities = extractEntities("Connection from 10.0.1.42 detected");
      expect(entities).toContainEqual({ entity: "10.0.1.42", type: "ip" });
    });

    test("extracts S3 buckets", () => {
      const entities = extractEntities("Data in s3://my-bucket-name was exposed");
      expect(entities).toContainEqual({ entity: "s3://my-bucket-name", type: "s3_bucket" });
    });

    test("deduplicates entities", () => {
      const entities = extractEntities("i-abc123def i-abc123def i-abc123def");
      const instances = entities.filter(e => e.type === "instance");
      expect(instances.length).toBe(1);
    });

    test("extracts multiple types from same text", () => {
      const entities = extractEntities(
        "Instance i-0ba6d18abd66116a4 in sg-12345678 has CVE-2025-99999"
      );
      expect(entities.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("store", () => {
    test("stores an item and returns it", () => {
      init();
      const item = store("sdp", "ticket", "12345", "Server down", "Web server i-0ba6d18abd66116a4 is not responding");
      expect(item).not.toBeNull();
      expect(item!.id).toBe("sdp:ticket:12345");
      expect(item!.source).toBe("sdp");
      expect(item!.entities!.length).toBeGreaterThan(0);
    });

    test("stores raw JSON to disk when provided", () => {
      init();
      const rawData = { ticket: { id: 12345, status: "open" } };
      const item = store("sdp", "ticket", "12345", "Test", "Body", rawData);
      expect(item!.file_path).not.toBeNull();
      expect(existsSync(item!.file_path!)).toBe(true);
    });

    test("upserts on duplicate ID", () => {
      init();
      store("sdp", "ticket", "12345", "Version 1", "Old body");
      store("sdp", "ticket", "12345", "Version 2", "New body");
      const s = stats();
      expect(s.total).toBe(1);
    });
  });

  describe("queryEntity", () => {
    test("finds items by entity across sources", () => {
      init();
      store("sdp", "ticket", "100", "SDP ticket", "Instance i-0ba6d18abd66116a4 is down");
      store("slack", "thread", "200", "Slack thread", "Alert for i-0ba6d18abd66116a4 fired");

      const results = queryEntity("i-0ba6d18abd66116a4");
      expect(results.length).toBe(2);
      const sources = results.map(r => r.source).sort();
      expect(sources).toEqual(["sdp", "slack"]);
    });

    test("returns empty for unknown entity", () => {
      init();
      const results = queryEntity("i-doesnotexist");
      expect(results.length).toBe(0);
    });

    test("case insensitive entity matching", () => {
      init();
      store("sdp", "ticket", "100", "Test", "Instance I-0BA6D18ABD66116A4 is running");
      const results = queryEntity("i-0ba6d18abd66116a4");
      expect(results.length).toBe(1);
    });
  });

  describe("search", () => {
    test("finds items by text content", () => {
      init();
      store("sdp", "ticket", "100", "Server outage", "The web server crashed at 3am");
      store("sdp", "ticket", "101", "Network issue", "DNS resolution failing intermittently");

      const results = search("server crashed");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].id).toBe("sdp:ticket:100");
    });

    test("filters by source", () => {
      init();
      store("sdp", "ticket", "100", "Outage", "Server down");
      store("slack", "thread", "200", "Outage", "Server down discussion");

      const results = search("server", "sdp");
      expect(results.length).toBe(1);
      expect(results[0].source).toBe("sdp");
    });

    test("returns empty for no match", () => {
      init();
      store("sdp", "ticket", "100", "Test", "Something");
      const results = search("xyznonexistent");
      expect(results.length).toBe(0);
    });
  });

  describe("recent", () => {
    test("returns items in reverse chronological order", () => {
      init();
      store("sdp", "ticket", "1", "First", "Body 1");
      store("sdp", "ticket", "2", "Second", "Body 2");
      store("sdp", "ticket", "3", "Third", "Body 3");

      const results = recent();
      expect(results.length).toBe(3);
      expect(results[0].id).toBe("sdp:ticket:3");
    });

    test("filters by source", () => {
      init();
      store("sdp", "ticket", "1", "SDP", "Body");
      store("slack", "thread", "2", "Slack", "Body");

      const results = recent("slack");
      expect(results.length).toBe(1);
      expect(results[0].source).toBe("slack");
    });

    test("respects limit", () => {
      init();
      for (let i = 0; i < 10; i++) store("sdp", "ticket", `${i}`, `T${i}`, "Body");
      const results = recent(undefined, 3);
      expect(results.length).toBe(3);
    });
  });

  describe("stats", () => {
    test("returns correct counts", () => {
      init();
      store("sdp", "ticket", "1", "T1", "Instance i-abc12345 down");
      store("slack", "thread", "2", "T2", "Alert for sg-12345678");

      const s = stats();
      expect(s.total).toBe(2);
      expect(s.by_source.sdp).toBe(1);
      expect(s.by_source.slack).toBe(1);
      expect(s.entities).toBeGreaterThan(0);
    });

    test("returns zero for empty cache", () => {
      init();
      const s = stats();
      expect(s.total).toBe(0);
    });
  });

  describe("evict", () => {
    test("removes nothing when under limit", () => {
      init();
      store("sdp", "ticket", "1", "Test", "Body");
      const result = evict(100); // 100GB — way above our test data
      expect(result.removed).toBe(0);
    });

    test("evicts oldest first when over limit", () => {
      init();
      store("sdp", "ticket", "1", "Oldest", "Body 1");
      store("sdp", "ticket", "2", "Middle", "Body 2");
      store("sdp", "ticket", "3", "Newest", "Body 3");

      // Force eviction with tiny limit (0.000001 GB = ~1KB)
      const result = evict(0.000001);
      // Should have removed items
      expect(result.removed).toBeGreaterThan(0);
    });
  });

  describe("getRaw", () => {
    test("retrieves stored raw JSON", () => {
      init();
      const rawData = { ticket: { id: 12345, notes: ["note1", "note2"] } };
      store("sdp", "ticket", "12345", "Test", "Body", rawData);

      const raw = getRaw("sdp:ticket:12345");
      expect(raw).toEqual(rawData);
    });

    test("returns null for item without raw data", () => {
      init();
      store("sdp", "ticket", "12345", "Test", "Body");
      const raw = getRaw("sdp:ticket:12345");
      expect(raw).toBeNull();
    });

    test("returns null for non-existent item", () => {
      init();
      const raw = getRaw("sdp:ticket:99999");
      expect(raw).toBeNull();
    });
  });

  describe("graceful degradation", () => {
    test("isAvailable returns true for temp dir", () => {
      expect(isAvailable()).toBe(true);
    });

    test("queryEntity returns empty when DB does not exist", () => {
      process.env.CACHE_DIR = "/nonexistent/path/that/does/not/exist";
      // isAvailable will return false, queryEntity returns []
      const results = queryEntity("anything");
      expect(results).toEqual([]);
    });
  });
});
