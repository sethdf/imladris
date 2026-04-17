-- Partner white-label customers: maps ChartMogul partner customers
-- to Salesforce accounts for reverse-ETL to Partner_Relationship__c
--
-- Data flow: ChartMogul Destinations → raw_chartmogul → stg_cm_customers → this view
-- Reverse-ETL reads this view and upserts to SF Partner_Relationship__c
--
-- 2,102 total customers, 322 active, $2.2M ARR across 9 partner channels
-- Partners: Pulsar ($1.36M), Meltwater ($790K), YouKnow ZAF, GoodHumans, Talkwalker, Isentia

with cm_partners as (
    select
        customer_id,
        customer_name,
        email,
        status,
        partner_channel,
        mrr,
        arr,
        is_white_label
    from {{ ref('stg_chartmogul_customers') }}
    where is_white_label = true
),
sf_accounts as (
    select
        account_id,
        account_name,
        lower(trim(account_name)) as account_name_clean
    from {{ ref('stg_salesforce_accounts') }}
),
-- Account matching: exact match on cleaned names
-- Exact match covers ~35%, fuzzy gets ~25%, manual handles rest
matched as (
    select
        cm.customer_id,
        cm.customer_name,
        cm.email,
        cm.status,
        cm.partner_channel,
        cm.mrr,
        cm.arr,
        sf.account_id as salesforce_account_id,
        sf.account_name as salesforce_account_name,
        case when sf.account_id is not null then 'exact' else 'unmatched' end as match_type
    from cm_partners cm
    left join sf_accounts sf
        on lower(trim(cm.customer_name)) = sf.account_name_clean
)
select
    customer_id,
    customer_name,
    email,
    status,
    partner_channel,
    mrr,
    arr,
    salesforce_account_id,
    salesforce_account_name,
    match_type,
    -- Fields for reverse-ETL to Partner_Relationship__c
    partner_channel as partner_name,
    true as white_label_flag,
    current_timestamp as _loaded_at
from matched
