with source as (
    select * from {{ source('salesforce', 'Contact') }}
),
renamed as (
    select
        "Id" as contact_id,
        "AccountId" as account_id,
        "Name" as contact_name,
        "Email" as email,
        "Title" as title,
        "OwnerId" as owner_id,
        "LeadSource" as lead_source,
        "IsDeleted" as is_deleted,
        "CreatedDate" as created_date,
        "LastModifiedDate" as last_modified_date,
        -- MQL/SQL dates may not exist on Contact - use null safely
        null::timestamp as mql_date,
        null::timestamp as sql_date
    from source
    where not coalesce("IsDeleted", false)
)
select * from renamed
