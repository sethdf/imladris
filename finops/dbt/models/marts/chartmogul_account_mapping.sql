-- Persistent account mapping: ChartMogul customer names → SF Account IDs
-- Used to maintain the mapping between ChartMogul and Salesforce
-- Manual overrides can be added via a seed file (mapping_overrides.csv)
--
-- This table is incremental — once a match is established, it persists

{{
    config(
        materialized='incremental',
        unique_key='customer_id'
    )
}}

with cm_customers as (
    select
        customer_id,
        customer_name,
        email,
        partner_channel,
        is_white_label
    from {{ ref('stg_chartmogul_customers') }}
),
sf_accounts as (
    select
        account_id,
        account_name,
        website,
        lower(trim(account_name)) as name_clean
    from {{ ref('stg_salesforce_accounts') }}
),
-- Exact name match
exact_matches as (
    select
        cm.customer_id,
        cm.customer_name,
        cm.email,
        cm.partner_channel,
        cm.is_white_label,
        sf.account_id as salesforce_account_id,
        'exact_name' as match_method,
        1.0 as match_confidence
    from cm_customers cm
    inner join sf_accounts sf
        on lower(trim(cm.customer_name)) = sf.name_clean
),
-- Unmatched customers (for manual review)
unmatched as (
    select
        cm.customer_id,
        cm.customer_name,
        cm.email,
        cm.partner_channel,
        cm.is_white_label,
        null::text as salesforce_account_id,
        'unmatched' as match_method,
        0.0 as match_confidence
    from cm_customers cm
    left join exact_matches em on cm.customer_id = em.customer_id
    where em.customer_id is null
),
combined as (
    select * from exact_matches
    union all
    select * from unmatched
)
select
    customer_id,
    customer_name,
    email,
    partner_channel,
    is_white_label,
    salesforce_account_id,
    match_method,
    match_confidence,
    current_timestamp as matched_at
from combined

{% if is_incremental() %}
where customer_id not in (select customer_id from {{ this }})
{% endif %}
