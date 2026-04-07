# =============================================================================
# imladris/postgres:pg16
#
# PostgreSQL 16 + pgvector + pgml + Apache AGE + pg_cron
# Built for linux/arm64 (EC2 Graviton) — pgml official image is PG15 only.
#
# Base:    pgvector/pgvector:pg16  (Debian bookworm, PG16, pgvector pre-installed)
# Adds:    pgml extension compiled from source (v2.10.0, pgrx=0.12.9)
#          Apache AGE v1.6.0 (graph queries via Cypher)
#          pg_cron v1.6.7 (scheduled jobs inside Postgres)
#          Python 3 + sentence-transformers for in-DB embedding models
#
# Databases created on first run (via init script):
#   windmill  — Windmill automation backend
#   pai       — PAI memory sync (core/work/personal/shared schemas)
# =============================================================================

# ── Stage 1: Compile pgml + AGE + pg_cron ───────────────────────────────────
FROM pgvector/pgvector:pg16 AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    binutils \
    cmake \
    curl \
    git \
    clang \
    libclang-dev \
    lld \
    libssl-dev \
    pkg-config \
    postgresql-server-dev-16 \
    python3 \
    python3-dev \
    python3-pip \
    libopenblas-dev \
    liblapack-dev \
    gfortran \
    libomp-dev \
    libstdc++-12-dev \
    flex \
    bison \
    libreadline-dev \
    && rm -rf /var/lib/apt/lists/*

# Install Rust (stable)
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --no-modify-path --default-toolchain stable

# Install cargo-pgrx — exact version required by pgml v2.10.0
RUN cargo install cargo-pgrx --version "=0.12.9" --locked

# Initialise pgrx against the PG16 installation in this image
RUN cargo pgrx init --pg16 $(which pg_config)

# Clone pgml v2.10.0 (shallow — extension only)
RUN git clone --depth 1 --branch v2.10.0 \
    https://github.com/postgresml/postgresml.git /tmp/pgml

WORKDIR /tmp/pgml/pgml-extension

# Build pgml for PG16 (release mode)
RUN cargo pgrx package --features pg16 --pg-config $(which pg_config)

# ── Compile Apache AGE v1.6.0 ──────────────────────────────────────────────
WORKDIR /tmp
RUN git clone --depth 1 --branch PG16/v1.6.0-rc0 \
    https://github.com/apache/age.git /tmp/age
WORKDIR /tmp/age
RUN make PG_CONFIG=$(which pg_config) install

# ── Compile pg_cron v1.6.7 ─────────────────────────────────────────────────
WORKDIR /tmp
RUN git clone --depth 1 --branch v1.6.7 \
    https://github.com/citusdata/pg_cron.git /tmp/pg_cron
WORKDIR /tmp/pg_cron
RUN make PG_CONFIG=$(which pg_config) && make install PG_CONFIG=$(which pg_config)

# ── Stage 2: Runtime image ────────────────────────────────────────────────────
FROM pgvector/pgvector:pg16

# Runtime deps: Python for pgml models + OpenMP for LightGBM/XGBoost
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3.11 \
    libpython3.11 \
    python3-pip \
    python3-venv \
    libgomp1 \
    libopenblas0 \
    && rm -rf /var/lib/apt/lists/*

# Install pgml Python runtime deps (minimum set for embeddings + extension load)
# torch for aarch64 is on standard PyPI (no --index-url needed)
RUN pip3 install --no-cache-dir --break-system-packages \
    xgboost \
    lightgbm \
    torch \
    sentence-transformers \
    transformers \
    huggingface-hub \
    datasets \
    orjson \
    evaluate \
    rouge \
    rouge-score \
    sacrebleu \
    sacremoses \
    "trl==0.9.6" \
    peft \
    catboost \
    ctransformers

# Copy compiled pgml extension from builder
COPY --from=builder \
    /tmp/pgml/pgml-extension/target/release/pgml-pg16/usr/lib/postgresql/16/lib/pgml.so \
    /usr/lib/postgresql/16/lib/pgml.so

COPY --from=builder \
    /tmp/pgml/pgml-extension/target/release/pgml-pg16/usr/share/postgresql/16/extension/ \
    /usr/share/postgresql/16/extension/

# Copy compiled Apache AGE extension from builder
COPY --from=builder \
    /usr/lib/postgresql/16/lib/age.so \
    /usr/lib/postgresql/16/lib/age.so
COPY --from=builder \
    /usr/share/postgresql/16/extension/age* \
    /usr/share/postgresql/16/extension/

# Copy compiled pg_cron extension from builder
COPY --from=builder \
    /usr/lib/postgresql/16/lib/pg_cron.so \
    /usr/lib/postgresql/16/lib/pg_cron.so
COPY --from=builder \
    /usr/share/postgresql/16/extension/pg_cron* \
    /usr/share/postgresql/16/extension/

# pgml model cache — models downloaded here on first use
ENV PGML_VENV=/var/lib/pgml/venv
RUN mkdir -p /var/lib/pgml && chown postgres:postgres /var/lib/pgml

# Copy init scripts — run on first container start (alphabetical order)
# 01: create pai database + core schema
# 02: create extensions in pai database
COPY docker-entrypoint-initdb.d/ /docker-entrypoint-initdb.d/
