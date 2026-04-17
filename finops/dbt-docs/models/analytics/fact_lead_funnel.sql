-- Fact: lead funnel tracking for conversion analysis
-- Tracks MQL→SQL→Opp progression from SF leads + contacts

with leads as (
    select
        lead_id as record_id,
        'lead' as record_type,
        lead_name as name,
        email,
        company,
        lead_source,
        brand,
        product_line,
        is_demo_request,
        is_trial,
        mql_date,
        sql_date,
        is_converted,
        converted_opportunity_id,
        created_date,
        -- Funnel stage
        case
            when is_converted then 'Converted'
            when sql_date is not null then 'SQL'
            when mql_date is not null then 'MQL'
            else 'Raw'
        end as funnel_stage,
        mql_date::date as mql_date_key,
        created_date::date as date_key
    from {{ ref('stg_salesforce_leads') }}
),
contacts as (
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
    where mql_date is not null or sql_date is not null
)
select * from leads
union all
select * from contacts
