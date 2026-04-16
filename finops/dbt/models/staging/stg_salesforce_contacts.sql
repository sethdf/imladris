with source as (
    select * from {{ source('salesforce', 'contacts') }}
),
renamed as (
    select
        id as contact_id,
        account_id,
        name as contact_name,
        email,
        title,
        owner_id,
        lead_source,
        is_deleted,
        created_date,
        last_modified_date,
        mql_date__c as mql_date,
        sql_date__c as sql_date
    from source
    where not coalesce(is_deleted, false)
)
select * from renamed
