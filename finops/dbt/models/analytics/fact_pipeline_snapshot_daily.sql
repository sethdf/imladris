-- Fact: daily pipeline snapshot for time series trending
-- Reads from the dbt snapshot of SF opportunities
-- Each row = one opportunity's state on a given snapshot date
--
-- This is the key time series table. It powers:
--   - Weekly Pipeline Trend (area chart)
--   - QTD Revenue Trend (line chart)
--   - Stage Aging analysis (bar chart)
--   - Partner Pipeline Trend (line chart)

with snapshots as (
    select
        opportunity_id,
        deal_name,
        account_id,
        owner_id,
        stage_name,
        amount,
        close_date,
        probability,
        is_won,
        is_closed,
        product_line,
        brand,
        coalesce(is_partner_deal, false) as is_partner_deal,
        dbt_valid_from::date as snapshot_date,
        dbt_valid_to,
        -- Is this the current version of the record?
        case when dbt_valid_to is null then true else false end as is_current,
        -- Pipeline stage flag
        case when not coalesce(is_closed, false) then true else false end as is_pipeline_stage,
        -- Age at snapshot
        dbt_valid_from::date - close_date::date as days_to_close_at_snapshot
    from {{ ref('snapshot_pipeline') }}
),
-- Generate a daily record for each opportunity active on each date
daily as (
    select
        s.opportunity_id,
        s.deal_name,
        s.account_id,
        s.owner_id,
        s.stage_name,
        s.amount,
        s.close_date,
        s.probability,
        s.is_won,
        s.is_closed,
        s.product_line,
        s.brand,
        s.is_partner_deal,
        s.snapshot_date,
        s.is_current,
        s.is_pipeline_stage,
        s.days_to_close_at_snapshot,
        md5(s.stage_name) as stage_id,
        s.snapshot_date as date_key,
        -- Amount at snapshot (for open pipeline value over time)
        case when s.is_pipeline_stage then s.amount else 0 end as amount_at_snapshot,
        -- Closed won amount (for revenue trend)
        case when s.is_won then s.amount else 0 end as amount_closed_won,
        -- Age of the deal at this snapshot point
        s.snapshot_date - s.close_date::date as age_days_at_snapshot
    from snapshots s
)
select * from daily
