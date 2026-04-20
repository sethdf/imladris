with source as (
    select * from {{ source('hubspot', 'deals') }}
),
renamed as (
    select
        id as deal_id,
        property_dealname as deal_name,
        property_amount as amount,
        property_dealstage as stage_name,
        property_closedate as close_date,
        property_pipeline as pipeline,
        property_hubspot_owner_id as owner_id,
        property_hs_is_closed_won as is_won,
        property_hs_is_closed as is_closed,
        property_createdate as created_date,
        property_hs_lastmodifieddate as last_modified_date,
        -- Custom properties
        property_brand as brand,
        property_product_line as product_line,
        property_is_partner_deal as is_partner_deal
    from source
)
select * from renamed
