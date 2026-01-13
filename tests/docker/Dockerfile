# Test environment for imladris DevBox scripts
# Mimics EC2 Ubuntu 24.04 environment

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# System packages (mirrors user-data-nix.sh setup_system)
RUN apt-get update && apt-get install -y \
    curl \
    git \
    gnupg \
    ca-certificates \
    unzip \
    jq \
    sudo \
    zsh \
    vim \
    # Testing tools
    bats \
    shellcheck \
    # Python for additional tests
    python3 \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Create ubuntu user (matches EC2 default)
RUN useradd -m -s /bin/bash -G sudo ubuntu && \
    echo 'ubuntu ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers

# Install Terraform for validation tests
ARG TERRAFORM_VERSION=1.6.6
RUN curl -fsSL https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_amd64.zip -o /tmp/terraform.zip && \
    unzip /tmp/terraform.zip -d /usr/local/bin && \
    rm /tmp/terraform.zip

# Install tflint for Terraform linting
RUN curl -fsSL https://github.com/terraform-linters/tflint/releases/latest/download/tflint_linux_amd64.zip -o /tmp/tflint.zip && \
    unzip /tmp/tflint.zip -d /usr/local/bin && \
    rm /tmp/tflint.zip

# Install bats-core with helper libraries
RUN git clone --depth 1 https://github.com/bats-core/bats-core.git /tmp/bats && \
    /tmp/bats/install.sh /usr/local && \
    rm -rf /tmp/bats

RUN git clone --depth 1 https://github.com/bats-core/bats-support.git /opt/bats-support && \
    git clone --depth 1 https://github.com/bats-core/bats-assert.git /opt/bats-assert && \
    git clone --depth 1 https://github.com/bats-core/bats-file.git /opt/bats-file

# Install mock bws CLI (for testing without real credentials)
COPY tests/docker/mock-bws /usr/local/bin/bws
RUN chmod +x /usr/local/bin/bws

# Set up test directories
WORKDIR /project
USER ubuntu

# Copy project files (done at runtime via volume mount for dev)
# For CI, files are copied during build

CMD ["/bin/bash"]
