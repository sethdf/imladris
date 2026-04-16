-- Executive snapshot: pre-aggregated KPI view
-- One row per snapshot_date x brand x product_line
-- This is the primary table Metabase dashboards read from
--
-- Maps to Power BI spec pages 1-4:
--   Page 1: Executive Scoreboard (closed won QTD/MTD, pipeline coverage, win rate, avg deal)
--   Page 2: Weekly Snapshot (all weekly KPIs)
--   Page 3: Funnel Health (MQLs, conversion rates)
--   Page 4: Partner Channel (partner deals, pipeline, won amounts)

with current_opps as (
    select * from {{ ref('fact_opportunity') }}
),
current_hs_deals as (
    select * from {{ ref('fact_deal_hubspot') }}
),
bookings as (
    select * from {{ ref('fact_bookings') }}
),
leads as (
    select * from {{ ref('fact_lead_funnel') }}
),
-- Closed Won metrics
closed_won_qtd as (
    select
        coalesce(brand, 'all') as brand,
        coalesce(product_line, 'all') as product_line,
        sum(amount) as closed_won_amount_qtd,
        count(*) as closed_won_count_qtd
    from bookings
    where date_trunc('quarter', booking_date::date) = date_trunc('quarter', current_date)
    group by rollup(brand, product_line)
),
closed_won_mtd as (
    select
        coalesce(brand, 'all') as brand,
        coalesce(product_line, 'all') as product_line,
        sum(amount) as closed_won_amount_mtd,
        count(*) as closed_won_count_mtd
    from bookings
    where date_trunc('month', booking_date::date) = date_trunc('month', current_date)
    group by rollup(brand, product_line)
),
-- Open pipeline
open_pipeline as (
    select
        coalesce(brand, 'all') as brand,
        coalesce(product_line, 'all') as product_line,
        sum(amount) as open_pipeline_amount,
        count(*) as open_pipeline_count,
        avg(amount) as avg_deal_size
    from current_opps
    where is_open = true
    group by rollup(brand, product_line)
),
-- In-month pipeline (closing this month)
inmonth_pipeline as (
    select
        coalesce(brand, 'all') as brand,
        coalesce(product_line, 'all') as product_line,
        sum(amount) as inmonth_pipeline_amount
    from current_opps
    where is_open = true
      and date_trunc('month', close_date::date) = date_trunc('month', current_date)
    group by rollup(brand, product_line)
),
-- Pipeline created this period
pipeline_created as (
    select
        coalesce(brand, 'all') as brand,
        coalesce(product_line, 'all') as product_line,
        sum(amount) as pipeline_created_total,
        sum(case when lead_source ilike '%inbound%' or lead_source ilike '%web%'
                 then amount else 0 end) as pipeline_created_inbound,
        sum(case when lead_source ilike '%outbound%' or lead_source ilike '%cold%'
                 then amount else 0 end) as pipeline_created_outbound
    from current_opps
    where date_trunc('quarter', created_date::date) = date_trunc('quarter', current_date)
    group by rollup(brand, product_line)
),
-- Win rates (trailing 60 days)
win_rates as (
    select
        coalesce(brand, 'all') as brand,
        coalesce(product_line, 'all') as product_line,
        count(case when is_won then 1 end)::numeric
            / nullif(count(case when is_closed then 1 end), 0) as win_rate_total,
        -- Inbound win rate
        count(case when is_won and (lead_source ilike '%inbound%' or lead_source ilike '%web%') then 1 end)::numeric
            / nullif(count(case when is_closed and (lead_source ilike '%inbound%' or lead_source ilike '%web%') then 1 end), 0) as win_rate_inbound_t60,
        -- Outbound win rate
        count(case when is_won and (lead_source ilike '%outbound%' or lead_source ilike '%cold%') then 1 end)::numeric
            / nullif(count(case when is_closed and (lead_source ilike '%outbound%' or lead_source ilike '%cold%') then 1 end), 0) as win_rate_outbound_t60
    from current_opps
    where is_closed and close_date::date >= current_date - interval '60 days'
    group by rollup(brand, product_line)
),
-- MQL metrics
mql_metrics as (
    select
        coalesce(brand, 'all') as brand,
        coalesce(product_line, 'all') as product_line,
        count(case when mql_date::date >= date_trunc('week', current_date) then 1 end) as mqls_weekly,
        count(case when mql_date::date >= date_trunc('year', current_date) then 1 end) as mqls_ytd,
        count(case when funnel_stage = 'SQL' then 1 end)::numeric
            / nullif(count(case when funnel_stage in ('MQL','SQL','Converted') then 1 end), 0) as mql_to_sql_pct_t60,
        count(case when funnel_stage in ('SQL','Converted')
                   and lead_source ilike '%inbound%' then 1 end) as high_potential_leads_weekly
    from leads
    where created_date::date >= current_date - interval '60 days'
    group by rollup(brand, product_line)
),
-- Partner metrics
partner_metrics as (
    select
        coalesce(brand, 'all') as brand,
        coalesce(product_line, 'all') as product_line,
        -- Partner closed won
        sum(case when is_partner_deal and is_won then amount else 0 end) as partner_closed_won_qtd,
        count(case when is_partner_deal and is_won then 1 end) as partner_closed_won_count,
        -- Partner open pipeline
        sum(case when is_partner_deal and is_open then amount else 0 end) as partner_open_pipeline,
        -- Partner MTD
        sum(case when is_partner_deal and is_won
                 and date_trunc('month', close_date::date) = date_trunc('month', current_date)
                 then amount else 0 end) as partner_closed_won_mtd,
        -- Partner avg deal
        avg(case when is_partner_deal and is_closed then amount end) as partner_avg_deal
    from current_opps
    where date_trunc('quarter', close_date::date) = date_trunc('quarter', current_date)
       or is_open
    group by rollup(brand, product_line)
),
-- Assemble the snapshot
final as (
    select
        current_date as snapshot_date,
        coalesce(q.brand, m.brand, o.brand, 'all') as brand,
        coalesce(q.product_line, m.product_line, o.product_line, 'all') as product_line,
        'ARR' as revenue_type,
        -- Closed won
        coalesce(q.closed_won_amount_qtd, 0) as closed_won_amount_qtd,
        coalesce(m.closed_won_amount_mtd, 0) as closed_won_amount_mtd,
        coalesce(q.closed_won_count_qtd, 0) as closed_won_count_period,
        -- Pipeline
        coalesce(o.open_pipeline_amount, 0) as open_pipeline_amount,
        coalesce(im.inmonth_pipeline_amount, 0) as inmonth_pipeline_amount,
        -- Coverage
        case when coalesce(q.closed_won_amount_qtd, 0) > 0
             then coalesce(o.open_pipeline_amount, 0) / q.closed_won_amount_qtd
             else null
        end as pipeline_coverage,
        -- Pipeline created
        coalesce(pc.pipeline_created_total, 0) as pipeline_created_total,
        coalesce(pc.pipeline_created_inbound, 0) as pipeline_created_inbound,
        coalesce(pc.pipeline_created_outbound, 0) as pipeline_created_outbound,
        -- Win rates
        w.win_rate_total,
        w.win_rate_inbound_t60,
        w.win_rate_outbound_t60,
        -- Deal size
        coalesce(o.avg_deal_size, 0) as avg_deal_size,
        -- MQLs
        coalesce(mq.mqls_weekly, 0) as mqls_weekly,
        coalesce(mq.mqls_ytd, 0) as mqls_ytd,
        mq.mql_to_sql_pct_t60,
        coalesce(mq.high_potential_leads_weekly, 0) as high_potential_leads_weekly,
        -- Partner
        coalesce(p.partner_closed_won_count, 0) as partner_closed_won_count,
        coalesce(p.partner_closed_won_qtd, 0) as partner_closed_won_qtd,
        coalesce(p.partner_closed_won_mtd, 0) as partner_closed_won_mtd,
        coalesce(p.partner_open_pipeline, 0) as partner_open_pipeline,
        p.partner_avg_deal
    from closed_won_qtd q
    full outer join closed_won_mtd m on q.brand = m.brand and q.product_line = m.product_line
    full outer join open_pipeline o on coalesce(q.brand, m.brand) = o.brand and coalesce(q.product_line, m.product_line) = o.product_line
    full outer join inmonth_pipeline im on coalesce(q.brand, m.brand, o.brand) = im.brand and coalesce(q.product_line, m.product_line, o.product_line) = im.product_line
    full outer join pipeline_created pc on coalesce(q.brand, m.brand, o.brand) = pc.brand and coalesce(q.product_line, m.product_line, o.product_line) = pc.product_line
    full outer join win_rates w on coalesce(q.brand, m.brand, o.brand) = w.brand and coalesce(q.product_line, m.product_line, o.product_line) = w.product_line
    full outer join mql_metrics mq on coalesce(q.brand, m.brand, o.brand) = mq.brand and coalesce(q.product_line, m.product_line, o.product_line) = mq.product_line
    full outer join partner_metrics p on coalesce(q.brand, m.brand, o.brand) = p.brand and coalesce(q.product_line, m.product_line, o.product_line) = p.product_line
)
select * from final
