# Amazon OpenSearch Service — the ONE cloud among aws/gcp/azure with a native
# managed OpenSearch offering (B9/B10, scalability audit). Multi-AZ, 3 data
# nodes + 3 dedicated masters, EBS-backed, encrypted at rest + in transit,
# fine-grained access control (master user/password, matching how the platform
# already authenticates to Postgres/Redis/ClickHouse — no request-signing
# client needed). Private VPC access only, reachable from EKS nodes.
#
# GCP/Azure have no equivalent native managed OpenSearch/Elasticsearch product;
# those clouds (and Hetzner) still run case-service's self-hosted single-node
# dev StatefulSet (deploy/k8s/data-tier/search-audit.yaml) until that gets a
# genuine multi-node/Keeper-coordinated HA variant (tracked as a follow-up —
# see docs/brd/58_production_hardening_BRD.md's B9/B10 log entry).

# Master-user password for OpenSearch's fine-grained access control — never
# hardcoded, generated like db_admin/redis_auth, published to Secrets Manager.
resource "random_password" "opensearch_master" {
  length  = 32
  special = false # OpenSearch master-user password disallows some specials; keep it simple/safe
}

resource "aws_security_group" "opensearch" {
  name        = "${var.name_prefix}-opensearch"
  description = "Allow OpenSearch from EKS nodes only"
  vpc_id      = module.vpc.vpc_id
}

resource "aws_security_group_rule" "opensearch_ingress_from_nodes" {
  type                     = "ingress"
  from_port                = 443
  to_port                  = 443
  protocol                 = "tcp"
  security_group_id        = aws_security_group.opensearch.id
  source_security_group_id = module.eks.node_security_group_id
  description              = "OpenSearch HTTPS from EKS worker nodes"
}

resource "aws_security_group_rule" "opensearch_egress" {
  type              = "egress"
  from_port         = 0
  to_port           = 0
  protocol          = "-1"
  security_group_id = aws_security_group.opensearch.id
  cidr_blocks       = ["0.0.0.0/0"]
  description       = "Allow all egress"
}

resource "aws_opensearch_domain" "this" {
  domain_name    = "${var.name_prefix}-cases"
  engine_version = var.opensearch_engine_version

  cluster_config {
    instance_type            = var.opensearch_instance_type
    instance_count           = var.opensearch_data_node_count
    zone_awareness_enabled   = var.opensearch_data_node_count >= 2
    dedicated_master_enabled = var.opensearch_dedicated_master_count > 0
    dedicated_master_type    = var.opensearch_dedicated_master_count > 0 ? var.opensearch_master_instance_type : null
    dedicated_master_count   = var.opensearch_dedicated_master_count > 0 ? var.opensearch_dedicated_master_count : null

    dynamic "zone_awareness_config" {
      for_each = var.opensearch_data_node_count >= 2 ? [1] : []
      content {
        availability_zone_count = min(var.opensearch_data_node_count, var.az_count)
      }
    }
  }

  ebs_options {
    ebs_enabled = true
    volume_type = "gp3"
    volume_size = var.opensearch_ebs_volume_size
  }

  encrypt_at_rest {
    enabled = true
  }

  node_to_node_encryption {
    enabled = true
  }

  domain_endpoint_options {
    enforce_https       = true
    tls_security_policy = "Policy-Min-TLS-1-2-2019-07"
  }

  advanced_security_options {
    enabled                        = true
    internal_user_database_enabled = true
    master_user_options {
      master_user_name     = var.opensearch_master_username
      master_user_password = random_password.opensearch_master.result
    }
  }

  vpc_options {
    subnet_ids         = slice(module.vpc.private_subnets, 0, min(var.opensearch_data_node_count, var.az_count, length(module.vpc.private_subnets)))
    security_group_ids = [aws_security_group.opensearch.id]
  }

  # Fine-grained access control (advanced_security_options) is the auth model
  # here, not resource-based domain policies — leave the domain policy open to
  # any principal that can already reach it over the private VPC endpoint.
  access_policies = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { AWS = "*" }
      Action    = "es:*"
      Resource  = "arn:aws:es:${var.region}:*:domain/${var.name_prefix}-cases/*"
    }]
  })
}
