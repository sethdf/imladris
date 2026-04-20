with source as (
    select * from {{ source('hubspot', 'contacts') }}
),
renamed as (
    select
        id as contact_id,
        property_email as email,
        property_firstname as first_name,
        property_lastname as last_name,
        property_company as company,
        property_hubspot_owner_id as owner_id,
        property_lifecyclestage as lifecycle_stage,
        property_hs_lead_status as lead_status,
        property_createdate as created_date,
        property_hs_lastmodifieddate as last_modified_date
    from source
)
select * from renamed
