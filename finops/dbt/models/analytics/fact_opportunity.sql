-- Fact: Salesforce opportunities with dimension keys
-- Used for deal detail drill-through and pipeline analysis

with opps as (
    select * from {{ ref('stg_salesforce_opportunities') }}
),
final as (
    select
        opportunity_id,
        deal_name,
        o.account_id,
        o.owner_id,
        o.stage_name,
        md5(o.stage_name) as stage_id,
        o.amount,
        o.close_date,
        o.close_date::date as close_date_key,
        o.deal_type,
        o.lead_source,
        o.is_won,
        o.is_closed,
        o.probability,
        o.fiscal_year,
        o.fiscal_quarter,
        o.product_line,
        o.brand,
        coalesce(o.is_partner_deal, false) as is_partner_deal,
        o.created_date,
        o.last_modified_date,
        -- Computed fields
        case when o.is_closed and not o.is_won then true else false end as is_closed_lost,
        case when not o.is_closed then true else false end as is_open,
        current_date - o.created_date::date as age_days
    from opps o
)
select * from final
