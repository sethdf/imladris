with source as (
    select * from {{ source('salesforce', 'Account') }}
),
renamed as (
    select
        "Id" as account_id,
        "Name" as account_name,
        "Type" as account_type,
        "Industry" as industry,
        "AnnualRevenue" as annual_revenue,
        "NumberOfEmployees" as number_of_employees,
        "OwnerId" as owner_id,
        "BillingCountry" as billing_country,
        "Website" as website,
        "IsDeleted" as is_deleted,
        "CreatedDate" as created_date,
        "LastModifiedDate" as last_modified_date,
        "Is_White_Label__c" as is_white_label,
        "ARR__c" as arr
    from source
    where not coalesce("IsDeleted", false)
)
select * from renamed
