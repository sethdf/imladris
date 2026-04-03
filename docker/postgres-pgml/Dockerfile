# =============================================================================
# postgres-pgml:pg16
#
# PostgreSQL 16 + pgvector + pgml (PostgresML) extension
# Built for linux/arm64 (EC2 Graviton) — pgml official image is PG15 only.
#
# Base:    pgvector/pgvector:pg16  (Debian bookworm, PG16, pgvector pre-installed)
# Adds:    pgml extension compiled from source (v2.10.0, pgrx=0.12.9)
#          Python 3 + sentence-transformers for in-DB embedding models
# =============================================================================

# ── Stage 1: Compile pgml extension ─────────────────────────────────────────
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

# pgml model cache — models downloaded here on first use
ENV PGML_VENV=/var/lib/pgml/venv
RUN mkdir -p /var/lib/pgml && chown postgres:postgres /var/lib/pgml
