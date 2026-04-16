-- Partner white-label customers: identifies accounts managed through
-- white-label partner channels. These feed the reverse-ETL to Salesforce
-- Partner_Relationship__c records for Crossbeam exposure.
--
-- Sources: salesforce accounts + hubspot companies (joined on domain/email)
-- Output: one row per partner-managed account with partner attribution

with sf_accounts as (
    select * from {{ ref('stg_salesforce_accounts') }}
),
final as (
    select
        account_id,
        account_name,
        account_type,
        industry,
        annual_revenue,
        -- Placeholder: partner attribution logic goes here once
        -- HubSpot partner data is available via Airbyte
        null as partner_name,
        null as partner_channel,
        null as white_label_flag,
        current_timestamp as _loaded_at
    from sf_accounts
    where account_type is not null
)
select * from final
