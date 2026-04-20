-- Brand dimension from seed data
-- Brands: Buxton, Audiense, Signal

select
    brand_id,
    brand_name,
    color_hex
from {{ ref('brands') }}
