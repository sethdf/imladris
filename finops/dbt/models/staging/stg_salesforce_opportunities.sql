with source as (
    select * from {{ source('salesforce', 'Opportunity') }}
),
renamed as (
    select
        "Id" as opportunity_id,
        "Name" as deal_name,
        "AccountId" as account_id,
        "OwnerId" as owner_id,
        "StageName" as stage_name,
        "Amount" as amount,
        "CloseDate" as close_date,
        "Type" as deal_type,
        "LeadSource" as lead_source,
        "IsWon" as is_won,
        "IsClosed" as is_closed,
        "IsDeleted" as is_deleted,
        "Probability" as probability,
        "FiscalYear" as fiscal_year,
        "FiscalQuarter" as fiscal_quarter,
        "CreatedDate" as created_date,
        "LastModifiedDate" as last_modified_date,
        "Sales_Division__c" as sales_division,
        "Buxton_Sales_Division__c" as buxton_sales_division,
        "Business_Unit__c" as business_unit,
        "Partner_Channel__c" as partner_channel,
        "Opportunity_Type__c" as opportunity_type,
        -- Map to the fields analytics models expect
        "Buxton_Sales_Division__c" as brand,
        "Business_Unit__c" as product_line,
        case when "Partner_Channel__c" is not null and "Partner_Channel__c" != '' then true else false end as is_partner_deal
    from source
    where not coalesce("IsDeleted", false)
)
select * from renamed
