# Parking Finder — Free Spots Near Epicentral

## Overview

CLI tool and optional Windmill cron that finds the closest free parking near Epicentral Coworking (220 E Pikes Peak Ave, Colorado Springs).

Data source: City of Colorado Springs parking system powered by SpotParking. Public API, no authentication required.

**Prototype tested 2026-04-01** — working code at `~/Projects/parking-finder/parking.ts`.

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

**Response:** Binary Protobuf (`application/octet-stream`), ~1.5 MB

#### Protobuf Structure (Reverse-Engineered)

```
Top level: repeated field 1 = GeohashGroup
  GeohashGroup:
    field 1 (string) = geohash (e.g. "9wvkvx")
    repeated field 2 (message) = Zone

  Zone:
    field 1 (message) = Schedule
      field 1 (varint) = totalIntervals
      field 2 (varint) = cycleDuration (30240 = ~3 weeks in minutes)
      field 3 (message) = baseDate
        field 1 (varint) = unix timestamp
      repeated field 4 (message) = ScheduleInterval
        field 1 (varint) = startOffset
        field 2 (varint) = duration
        field 7 (varint) = restrictionType
        field 8 (varint) = intervalIndex
    repeated field 2 (message) = Coordinate
      field 1 (double) = latitude
      field 2 (double) = longitude
    field 3 (string) = zone UUID
    field 4 (varint) = zoneType (0=Street, 1=Route, 2=Outline, 3=Bay, 4=Garage)
    field 9 (varint) = directionality
```

#### Restriction Types (schedule.field4.field7)

| Value | Meaning | Count (tested) |
|-------|---------|----------------|
| 0 | Free/Unrestricted | 14,065 intervals |
| 1 | Permit Required | 279 intervals |
| 2 | Metered/Paid | 13,581 intervals |
| 3 | Time-Limited | 3,967 intervals |
| 4 | No Parking | 1,954 intervals |
| 98 | Special | 14 intervals |

**Key finding:** Most downtown street zones are "mixed" — they alternate between free (restriction=0) at certain hours and metered/restricted at other times. Single-interval zones with restriction=4 (no parking) are most common (1,248 of 1,437 simple zones).

#### Zone Counts (Tested 2026-04-01)

- **2,177 total zones** parsed (14 geohash cells)
- **2,122 street** (type 0) — the useful ones for parking
- **35 outlines** (type 2) — area boundaries, not parkable
- **14 routes** (type 1)
- **6 garages** (type 4, 3 unique — duplicated across geohash cells)

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

**Status as of 2026-04-01: NO ZONES RETURNING DATA.** The API accepts requests and returns structured responses, but every zone returns `{"type": "Error", "value": "Not Found"}` for all occupancy fields. This includes garages, outlines, and street zones. Either sensors are not deployed in Colorado Springs, or the data feed is down. The endpoint should be re-tested periodically — the infrastructure exists even if the data doesn't flow yet.

## Epicentral Location

- **Address:** 220 E Pikes Peak Ave, Colorado Springs, CO 80903
- **Coordinates:** 38.8339, -104.8186

## Test Results (2026-04-01)

Within 0.5 mi of Epicentral:
- **12 always-free zones** (closest at 0.26 mi)
- **280 mixed zones** (free at certain hours, metered at others)
- **0 metered-only zones** (all metered zones also have free intervals)
- **592 restricted zones** (no parking, permit only)

The closest always-free zone is at `38.8336, -104.8235` (~0.26 mi walk, ~5 min).

## Implementation

### Phase 1: CLI Tool (Prototype Complete)

**Prototype location:** `~/Projects/parking-finder/parking.ts`

**What works now:**
1. Fetches all zone geometry from SpotParking API
2. Decodes Protobuf using `protobufjs` generic reader (no .proto schema needed)
3. Parses schedule intervals and extracts restriction types per zone
4. Classifies zones as Free / Free* (time-dependent) / Mixed / Metered / Restricted
5. Calculates haversine distance from Epicentral
6. Outputs sorted list with Google Maps links for each zone

**What needs work for production:**
- **Time-aware filtering:** Parse the schedule cycle (30240 minutes, ~3 weeks) to determine which restriction applies RIGHT NOW, not just whether free intervals exist
- **Zone caching:** Cache protobuf response locally, refresh daily
- **Deduplication:** Some zones appear in multiple geohash cells (garages confirmed duplicated)
- **Street names:** The API doesn't return street names. Could reverse-geocode centroids via Google Maps or OpenStreetMap Nominatim
- **Google Maps links → directions:** Replace `?q=lat,lng` with `?saddr=Epicentral&daddr=lat,lng` for walking directions

### Phase 2: Windmill Cron (Future)

**Location:** `windmill/f/devops/parking_check.ts`

Blocked by occupancy sensors — without live availability data, a morning notification would just show the same static list every day. Revisit when the occupancy endpoint starts returning data.

**Alternative:** Could still be useful if time-aware filtering is implemented — notify which zones are currently in their "free" window based on schedule data alone.

### Phase 3: Enhancements (Future)

- **Walking directions:** Google Maps Directions API for actual walking time
- **Historical patterns:** If occupancy sensors come online, log data to predict best arrival windows
- **Interactive map:** Simple HTML page with Leaflet showing free zones color-coded by distance

## Technical Notes

- **No auth required.** API is open, CORS allows all origins. Only needs `Origin: https://colorado-springs.modii.co` header.
- **Protobuf decoding without .proto schema.** The prototype uses `protobufjs.Reader` for generic field-by-field parsing. Wire types: 0=varint, 1=double, 2=length-delimited (strings, bytes, sub-messages), 5=float32. This approach is brittle but works and avoids needing to extract the full .proto definition from the Modii JS bundle.
- **Rate limiting:** Unknown. The prototype makes 1 API call per run. Be respectful.
- **Fragility:** Undocumented API. Could change without notice.

## Dependencies

- `protobufjs` — Protobuf decoding
- Bun runtime

## Priority

Low — quality of life tool. Prototype works. Productionize when there's downtime.
