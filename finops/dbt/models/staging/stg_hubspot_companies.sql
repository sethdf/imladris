with source as (
    select * from {{ source('hubspot', 'companies') }}
),
renamed as (
    select
        id as company_id,
        property_name as company_name,
        property_domain as domain,
        property_industry as industry,
        property_annualrevenue as annual_revenue,
        property_numberofemployees as number_of_employees,
        property_hubspot_owner_id as owner_id,
        property_createdate as created_date,
        property_hs_lastmodifieddate as last_modified_date
    from source
)
select * from renamed
