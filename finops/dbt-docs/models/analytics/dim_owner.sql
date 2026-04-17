-- Owner dimension: derived from distinct owner_ids in opportunities
-- Will be enriched when SF User object is added to Airbyte sources

with sf_owners as (
    select distinct owner_id
    from {{ ref('stg_salesforce_opportunities') }}
    where owner_id is not null
),
hs_owners as (
    select distinct owner_id
    from {{ ref('stg_hubspot_deals') }}
    where owner_id is not null
),
all_owners as (
    select owner_id from sf_owners
    union
    select owner_id from hs_owners
)
select
    owner_id,
    -- Placeholder fields until SF User object is synced
    null::text as owner_name,
    null::text as owner_email,
    null::text as manager_id,
    null::text as manager_name,
    null::text as team
from all_owners
