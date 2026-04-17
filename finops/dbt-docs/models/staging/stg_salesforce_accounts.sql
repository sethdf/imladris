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
        billing_country,
        website,
        is_deleted,
        created_date,
        last_modified_date
    from source
    where not coalesce(is_deleted, false)
)
select * from renamed
