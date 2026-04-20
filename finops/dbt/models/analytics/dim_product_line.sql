-- Product line dimension from seed data
-- Product lines: Location, Discovery, Signals, Action, Data Services

select
    product_line_id,
    product_line_name,
    description
from {{ ref('product_lines') }}
