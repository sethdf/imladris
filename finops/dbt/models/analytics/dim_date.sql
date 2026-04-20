-- Date dimension: calendar + fiscal logic
-- Buxton fiscal year = calendar year

with date_spine as (
    select
        d::date as date_key
    from generate_series('2020-01-01'::date, '2030-12-31'::date, '1 day'::interval) d
),
enriched as (
    select
        date_key,
        extract(year from date_key)::int as calendar_year,
        extract(quarter from date_key)::int as calendar_quarter,
        extract(month from date_key)::int as calendar_month,
        extract(week from date_key)::int as calendar_week,
        extract(dow from date_key)::int as day_of_week,
        to_char(date_key, 'YYYY-MM') as year_month,
        to_char(date_key, 'YYYY-"Q"Q') as year_quarter,
        to_char(date_key, 'Month') as month_name,
        to_char(date_key, 'Day') as day_name,
        -- Fiscal = calendar for Buxton
        extract(year from date_key)::int as fiscal_year,
        extract(quarter from date_key)::int as fiscal_quarter,
        -- Relative date flags
        case when date_key = current_date then true else false end as is_today,
        case when date_trunc('month', date_key) = date_trunc('month', current_date)
             then true else false end as is_current_month,
        case when date_trunc('quarter', date_key) = date_trunc('quarter', current_date)
             then true else false end as is_current_quarter,
        case when date_trunc('year', date_key) = date_trunc('year', current_date)
             then true else false end as is_current_year
    from date_spine
)
select * from enriched
