with sf_owners as (
    select distinct owner_id
    from {{ ref('stg_salesforce_opportunities') }}
    where owner_id is not null
)
select
    owner_id,
    null::text as owner_name,
    null::text as owner_email,
    null::text as manager_id,
    null::text as manager_name,
    null::text as team
from sf_owners
