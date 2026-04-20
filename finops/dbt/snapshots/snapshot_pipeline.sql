{% snapshot snapshot_pipeline %}

{{
    config(
        target_schema='snapshots',
        unique_key='opportunity_id',
        strategy='timestamp',
        updated_at='last_modified_date',
    )
}}

select
    "Id" as opportunity_id,
    "Name" as deal_name,
    "AccountId" as account_id,
    "OwnerId" as owner_id,
    "StageName" as stage_name,
    "Amount" as amount,
    "CloseDate" as close_date,
    "Probability" as probability,
    "IsWon" as is_won,
    "IsClosed" as is_closed,
    "Business_Unit__c" as product_line,
    "Buxton_Sales_Division__c" as brand,
    case when "Partner_Channel__c" is not null and "Partner_Channel__c" != '' then true else false end as is_partner_deal,
    "LastModifiedDate" as last_modified_date
from {{ source('salesforce', 'Opportunity') }}
where not coalesce("IsDeleted", false)

{% endsnapshot %}
