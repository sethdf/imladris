with source as (
    select * from {{ source('salesforce', 'leads') }}
),
renamed as (
    select
        id as lead_id,
        name as lead_name,
        email,
        company,
        status as lead_status,
        lead_source,
        owner_id,
        is_converted,
        converted_account_id,
        converted_contact_id,
        converted_opportunity_id,
        converted_date,
        is_deleted,
        created_date,
        last_modified_date,
        -- Custom fields for funnel tracking
        brand__c as brand,
        product_line__c as product_line,
        is_demo_request__c as is_demo_request,
        is_trial__c as is_trial,
        mql_date__c as mql_date,
        sql_date__c as sql_date
    from source
    where not coalesce(is_deleted, false)
)
select * from renamed
