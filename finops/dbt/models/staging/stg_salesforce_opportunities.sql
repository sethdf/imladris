with source as (
    select * from {{ source('salesforce', 'opportunities') }}
),
renamed as (
    select
        id as opportunity_id,
        name as deal_name,
        account_id,
        owner_id,
        stage_name,
        amount,
        close_date,
        type as deal_type,
        lead_source,
        is_won,
        is_closed,
        is_deleted,
        probability,
        fiscal_year,
        fiscal_quarter,
        created_date,
        last_modified_date,
        -- Custom fields Brandon's spec references
        product_line__c as product_line,
        brand__c as brand,
        is_partner_deal__c as is_partner_deal
    from source
    where not coalesce(is_deleted, false)
)
select * from renamed
