# Parking Finder — Free Spots Near Epicentral

## Overview

CLI tool and optional Windmill cron that finds the closest free parking with real-time availability near Epicentral Coworking (220 E Pikes Peak Ave, Colorado Springs).

Data source: City of Colorado Springs parking system powered by SpotParking. Public API, no authentication required.

## API Details

**Base URL:** `https://api2.spotparking.com.au`

### Zone Geometry & Rules

```
POST /1.4/query/client/zoneGroups
Content-Type: application/json
Origin: https://colorado-springs.modii.co
```

**Request:**
```json
{
  "geohashes": [
    "9wvkvx","9wvkvz","9wvkye","9wvkyg",
    "9wvkys","9wvkyt","9wvkyu","9wvkyv",
    "9wvkyw","9wvkyx","9wvkyy","9wvkyz",
    "9wvmj8","9wvmjb"
  ],
  "precision": 6
}
```

**Response:** Binary Protobuf (`application/octet-stream`), type `spotparking.GeoHashCollectionOfZones`

**Fields per zone:**
- `id` — UUID string (stable identifier)
- `type` — NORMAL, OUTLINE, BAY, GARAGE, MULTI_LEVEL, POI, ROUTE, AREA
- `paths[]` — lat/lon polygon points defining zone boundary
- `schedule` — parking rules (time windows, intervals, restrictions)
- `tariffs[]` — `chargeInterval`, `currency`, `displayCharge`, `displayChargeUnitSize`, `cappedCharge`
- `conditions` — restriction type details (free, metered, loading, reserved, etc.)

**Notes:**
- 566 total zones across downtown Colorado Springs
- Response is ~1.5 MB Protobuf; Protobuf schema embedded in the Modii JS bundle
- Cache this data — zone geometry changes infrequently (daily refresh is fine)

### Real-Time Occupancy

```
POST /1.4/dynamic/complex
Content-Type: application/json
Origin: https://colorado-springs.modii.co
```

**Request:**
```json
{
  "requiredData": {
    "<zone-uuid>": {
      "_zoneId": "<zone-uuid>",
      "occupancy": ["occupancyRate", "occupancyStatus", "capacity", "occupancyLastUpdate"]
    }
  }
}
```

**Response:**
```json
{
  "data": {
    "<zone-uuid>": {
      "_zoneId": "<zone-uuid>",
      "occupancy": [
        {"occupancyRate": {"value": 0, "type": "Number"}},
        {"occupancyStatus": {"value": "LOW", "type": "String"}},
        {"capacity": {"value": 10, "type": "Number"}},
        {"occupancyLastUpdate": {"value": "2026-04-01T18:15:57.923Z", "type": "Date"}}
      ]
    }
  }
}
```

**Notes:**
- 311 of 566 zones have live occupancy sensors
- Timestamps update sub-minute (near real-time)
- `occupancyStatus` values: LOW, MEDIUM, HIGH
- Can batch multiple zone IDs in a single request
- EV charger status also available via `chargingStatus` field

### Zone References

```
GET /1.1/query/references?zoneReferenceId=<uuid>
```

Returns zone metadata (areaReferenceId, rawDataPointIds). Useful for grouping zones by area.

## Epicentral Location

- **Address:** 220 E Pikes Peak Ave, Colorado Springs, CO 80903
- **Coordinates:** 38.8339, -104.8186

## Implementation

### Phase 1: CLI Tool

**Location:** `scripts/parking-finder.ts` (Bun TypeScript)

**Behavior:**
1. On first run, fetch all zone geometry from `/1.4/query/client/zoneGroups`
2. Decode Protobuf response (extract schema from Modii JS bundle, or reverse-engineer minimal proto definition)
3. Filter for free parking zones (tariff displayCharge = 0 or no tariff)
4. Calculate centroid of each free zone polygon
5. Compute walking distance from Epicentral coordinates (haversine for initial sort, optionally Google Directions API for walking time)
6. For the nearest N free zones, hit `/1.4/dynamic/complex` for live occupancy
7. Output ranked list: distance, capacity, occupancy status, last updated

**Cache strategy:**
- Zone geometry cached to `~/.cache/parking-finder/zones.json` (refresh daily)
- Occupancy fetched live on every run

**Output format:**
```
Parking near Epicentral (220 E Pikes Peak Ave)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 #  Zone                Distance  Spots  Status   Updated
 1  S Nevada Ave (100)  0.1 mi    8/10   LOW      2m ago
 2  E Pikes Peak (300)  0.2 mi    3/6    MEDIUM   1m ago
 3  S Tejon St (200)    0.3 mi    12/15  LOW      30s ago
```

### Phase 2: Windmill Cron (Optional)

**Location:** `windmill/f/devops/parking_check.ts`

**Behavior:**
- Runs weekday mornings before typical arrival (e.g. 7:30 AM MT)
- Checks occupancy of top 5 nearest free zones
- Sends Slack notification with best option
- Only notifies if a LOW occupancy spot exists within 0.3 miles

### Phase 3: Enhancements (Optional)

- Time-aware filtering: some free zones have time restrictions (e.g. free after 6 PM only). Use schedule data to filter for currently-free zones.
- Walking directions: integrate with Google Maps Directions API for actual walking time instead of haversine distance.
- Historical patterns: log occupancy over time to predict best arrival windows.

## Technical Considerations

- **Protobuf decoding:** The zone geometry endpoint returns binary Protobuf. Need to either:
  - Extract the `.proto` schema from the Modii JS bundle (`spotparking.GeoHashCollectionOfZones`)
  - Use `protobuf.js` with a reverse-engineered minimal schema
  - Or parse the raw binary with a generic Protobuf decoder
- **No auth required:** API is open with `Access-Control-Allow-Origin: *`. Only need `Origin: https://colorado-springs.modii.co` header.
- **Rate limiting:** Unknown. Be respectful — cache geometry, only poll occupancy when needed.
- **Fragility:** This is an undocumented API. Could change without notice. Pin to known working request formats.

## Dependencies

- `protobufjs` or equivalent for Protobuf decoding
- Bun runtime (consistent with imladris tooling)
- Optional: Google Maps API key for walking directions

## Priority

Low — quality of life tool. Build when there's downtime.
