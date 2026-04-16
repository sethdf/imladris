-- ChartMogul Destinations pushes to raw_chartmogul schema.
-- The "Channel" custom attribute IS the white-label signal per Part 2 PDF.
-- 2,102 total customers, 322 active, across 9 partner channels.
-- Partners: Pulsar, Meltwater, YouKnow ZAF, GoodHumans, Talkwalker, Isentia

with source as (
    select * from {{ source('chartmogul', 'customers') }}
),
renamed as (
    select
        id as customer_id,
        external_id,
        name as customer_name,
        email,
        status,
        customer_since,
        -- ChartMogul custom attributes contain the channel
        attributes->>'Channel' as partner_channel,
        attributes->>'tags' as tags,
        mrr,
        arr,
        currency,
        country_code,
        city,
        lead_created_at,
        free_trial_started_at,
        -- Derive partner vs direct
        case
            when attributes->>'Channel' is not null
                 and attributes->>'Channel' != ''
            then true
            else false
        end as is_white_label
    from source
)
select * from renamed
