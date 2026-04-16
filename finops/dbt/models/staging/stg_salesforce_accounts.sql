with source as (
    select * from {{ source('salesforce', 'accounts') }}
),
renamed as (
    select
        id as account_id,
        name as account_name,
        type as account_type,
        industry,
        annual_revenue,
        number_of_employees,
        owner_id,
        created_date,
        last_modified_date
    from source
)
select * from renamed
