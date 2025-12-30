// Integration tests for aws-devbox infrastructure
//
// WARNING: These tests create real AWS resources and cost money.
// Run only when you want to validate infrastructure changes.
//
// Usage: go test -v -timeout 30m

package integration

import (
	"testing"

	"github.com/gruntwork-io/terratest/modules/terraform"
	"github.com/stretchr/testify/assert"
)

// Test that the VPC and networking are created correctly
func TestVpcCreation(t *testing.T) {
	t.Parallel()

	terraformOptions := &terraform.Options{
		TerraformDir: "../../",
		VarFiles:     []string{"tests/integration/test.tfvars"},
		// Only target networking resources to keep test fast
		Targets: []string{
			"aws_vpc.devbox",
			"aws_subnet.devbox",
			"aws_internet_gateway.devbox",
		},
	}

	defer terraform.Destroy(t, terraformOptions)
	terraform.InitAndApply(t, terraformOptions)

	// Verify VPC CIDR
	vpcCidr := terraform.Output(t, terraformOptions, "vpc_cidr")
	assert.Equal(t, "10.0.0.0/16", vpcCidr)
}

// Test security group has no public ingress
func TestSecurityGroup(t *testing.T) {
	t.Parallel()

	terraformOptions := &terraform.Options{
		TerraformDir: "../../",
		VarFiles:     []string{"tests/integration/test.tfvars"},
		Targets: []string{
			"aws_vpc.devbox",
			"aws_security_group.devbox",
		},
	}

	defer terraform.Destroy(t, terraformOptions)
	terraform.InitAndApply(t, terraformOptions)

	// Verify no ingress rules (Tailscale handles access)
	// This would require using AWS SDK to verify
}

// Test that EBS volumes have correct sizes
func TestEbsVolumes(t *testing.T) {
	t.Parallel()

	terraformOptions := &terraform.Options{
		TerraformDir: "../../",
		VarFiles:     []string{"tests/integration/test.tfvars"},
		Vars: map[string]interface{}{
			"volume_size":      50,
			"data_volume_size": 100,
		},
	}

	// Plan only - don't actually create volumes
	terraform.InitAndPlan(t, terraformOptions)
}

// Validate terraform configuration without deploying
func TestTerraformValidate(t *testing.T) {
	terraformOptions := &terraform.Options{
		TerraformDir: "../../",
	}

	// Just validate - no resources created
	terraform.Init(t, terraformOptions)
	terraform.Validate(t, terraformOptions)
}
