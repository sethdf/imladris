terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    bitwarden = {
      source  = "maxlaverse/bitwarden"
      version = ">= 0.12.0"
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
