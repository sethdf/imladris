-- Fact: HubSpot deals (Signal brand primarily)
-- HubSpot source not yet synced. This creates an empty table with correct schema.
-- Will populate once HubSpot connector is configured in Airbyte.

select
    null::text as deal_id,
    null::text as deal_name,
    null::text as owner_id,
    null::text as stage_name,
    null::numeric as amount,
    null::date as close_date,
    null::date as close_date_key,
    null::text as pipeline,
    false as is_won,
    false as is_closed,
    null::text as brand,
    null::text as product_line,
    false as is_partner_deal,
    null::timestamp as created_date,
    null::timestamp as last_modified_date,
    false as is_closed_lost,
    true as is_open
where false
