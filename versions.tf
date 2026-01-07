terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    bitwarden-secrets = {
      source  = "bitwarden/bitwarden-secrets"
      version = ">= 0.1.0"
    }
  }
}

provider "aws" {
  region  = var.aws_region
  profile = "buxtonit"

  default_tags {
    tags = {
      Project     = "aws-devbox"
      ManagedBy   = "terraform"
      Environment = "dev"
    }
  }
}
