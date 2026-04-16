-- Lead source dimension: derived from distinct lead sources
-- Classification logic maps raw lead sources to categories

with sources as (
    select distinct lead_source
    from {{ ref('stg_salesforce_opportunities') }}
    where lead_source is not null
    union
    select distinct lead_source
    from {{ ref('stg_salesforce_leads') }}
    where lead_source is not null
),
classified as (
    select
        md5(lead_source) as lead_source_id,
        lead_source,
        case
            when lead_source ilike '%partner%' then 'Partner'
            when lead_source ilike '%referral%' then 'Referral'
            when lead_source ilike '%web%' or lead_source ilike '%inbound%' then 'Inbound'
            when lead_source ilike '%outbound%' or lead_source ilike '%cold%' then 'Outbound'
            when lead_source ilike '%event%' or lead_source ilike '%conference%' then 'Event'
            when lead_source ilike '%paid%' or lead_source ilike '%ad%' then 'Paid'
            else 'Other'
        end as source_category,
        case
            when lead_source ilike '%partner%' or lead_source ilike '%referral%' then false
            else true
        end as is_inbound
    from sources
)
select * from classified
