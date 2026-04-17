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
    id as opportunity_id,
    name as deal_name,
    account_id,
    owner_id,
    stage_name,
    amount,
    close_date,
    probability,
    is_won,
    is_closed,
    product_line__c as product_line,
    brand__c as brand,
    is_partner_deal__c as is_partner_deal,
    last_modified_date
from {{ source('salesforce', 'opportunities') }}
where not coalesce(is_deleted, false)

{% endsnapshot %}
