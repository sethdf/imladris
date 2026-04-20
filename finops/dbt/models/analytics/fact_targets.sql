-- Fact: revenue and pipeline targets for attainment calculation
-- Loaded from seed data until a proper target-setting system exists
-- Structure matches what executive_snapshot needs for coverage calculations

with targets as (
    select
        period_date::date as date_key,
        to_char(period_date::date, 'YYYY-MM') as period_key,
        brand,
        product_line,
        target_type,
        target_value
    from {{ ref('targets') }}
)
select * from targets
