-- Stage dimension: names + win probability
-- Derived from distinct stages in Salesforce opportunities

with stages as (
    select distinct
        stage_name,
        probability
    from {{ ref('stg_salesforce_opportunities') }}
    where stage_name is not null
),
enriched as (
    select
        md5(stage_name) as stage_id,
        stage_name,
        probability,
        case
            when probability >= 90 then 'Commit'
            when probability >= 60 then 'Best Case'
            when probability >= 30 then 'Pipeline'
            when probability > 0 then 'Early'
            else 'Closed/Other'
        end as forecast_category,
        case
            when stage_name ilike '%closed won%' then true
            else false
        end as is_closed_won,
        case
            when stage_name ilike '%closed%' then true
            else false
        end as is_closed,
        -- Pipeline stage flag (open, active stages)
        case
            when stage_name not ilike '%closed%' then true
            else false
        end as is_pipeline_stage
    from stages
)
select * from enriched
