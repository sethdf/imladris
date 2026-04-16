FROM python:3.12-slim

RUN pip install --no-cache-dir dbt-core==1.9.* dbt-postgres==1.9.*

WORKDIR /dbt
COPY dbt_project.yml profiles.yml ./
COPY models/ models/
COPY macros/ macros/
COPY seeds/ seeds/
COPY tests/ tests/
COPY analyses/ analyses/

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
