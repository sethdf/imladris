-- Fact: lead/contact funnel tracking
-- Note: Lead table was not synced from Salesforce.
-- Using Contact records with lifecycle tracking only.

with contacts as (
    select
        contact_id as record_id,
        'contact' as record_type,
        contact_name as name,
        email,
        null as company,
        lead_source,
        null as brand,
        null as product_line,
        false as is_demo_request,
        false as is_trial,
        mql_date,
        sql_date,
        false as is_converted,
        null as converted_opportunity_id,
        created_date,
        case
            when sql_date is not null then 'SQL'
            when mql_date is not null then 'MQL'
            else 'Raw'
        end as funnel_stage,
        mql_date::date as mql_date_key,
        created_date::date as date_key
    from {{ ref('stg_salesforce_contacts') }}
)
select * from contacts
