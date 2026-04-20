-- Fact: unified bookings (closed-won deals) from Salesforce + HubSpot
-- Single table for total closed-won reporting across brands

with sf_bookings as (
    select
        opportunity_id as booking_id,
        'salesforce' as source_system,
        deal_name,
        account_id,
        owner_id,
        amount,
        close_date as booking_date,
        close_date::date as date_key,
        product_line,
        brand,
        is_partner_deal,
        created_date
    from {{ ref('fact_opportunity') }}
    where is_won = true
),
hs_bookings as (
    select
        deal_id as booking_id,
        'hubspot' as source_system,
        deal_name,
        null as account_id,
        owner_id,
        amount,
        close_date as booking_date,
        close_date as date_key,
        product_line,
        brand,
        is_partner_deal,
        created_date
    from {{ ref('fact_deal_hubspot') }}
    where is_won = true
),
unified as (
    select * from sf_bookings
    union all
    select * from hs_bookings
)
select * from unified
