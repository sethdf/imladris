-- Fact: HubSpot deals (Signal brand primarily)
-- Mirrors fact_opportunity structure for unified reporting

with deals as (
    select * from {{ ref('stg_hubspot_deals') }}
),
final as (
    select
        deal_id,
        deal_name,
        d.owner_id,
        d.stage_name,
        d.amount::numeric as amount,
        d.close_date::date as close_date,
        d.close_date::date as close_date_key,
        d.pipeline,
        coalesce(d.is_won, false) as is_won,
        coalesce(d.is_closed, false) as is_closed,
        d.brand,
        d.product_line,
        coalesce(d.is_partner_deal, false) as is_partner_deal,
        d.created_date,
        d.last_modified_date,
        case when d.is_closed and not d.is_won then true else false end as is_closed_lost,
        case when not coalesce(d.is_closed, false) then true else false end as is_open
    from deals d
)
select * from final
