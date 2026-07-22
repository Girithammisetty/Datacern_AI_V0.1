# The single Secrets Manager secret that External Secrets Operator syncs into
# the K8s Secret `datacern-secrets` (see deploy/CONFIG.md). Its JSON is built by
# merging:
#   * var.secrets          — application-owned creds supplied later (JWT, SMTP,
#                            per-DB app passwords, optional LLM keys, ...)
#   * computed endpoints   — connection details for the infra provisioned here
#                            (RDS host, Redis URL, Kafka bootstrap, S3 config)
#                            plus the infra creds Terraform generated.
# Computed values win on key collisions so the secret always reflects reality.

locals {
  computed_secrets = {
    # --- PostgreSQL (admin/DDL role; app roles come from var.secrets) ---
    POSTGRES_HOST           = aws_db_instance.this.address
    POSTGRES_PORT           = tostring(aws_db_instance.this.port)
    POSTGRES_ADMIN_USER     = var.db_admin_username
    POSTGRES_ADMIN_PASSWORD = random_password.db_admin.result

    # --- Redis (managed TLS -> rediss://) ---
    REDIS_URL = "rediss://:${random_password.redis_auth.result}@${aws_elasticache_replication_group.this.primary_endpoint_address}:6379"

    # --- OpenSearch (case-service search/facets; B9/B10) ---
    OPENSEARCH_URL      = "https://${aws_opensearch_domain.this.endpoint}"
    OPENSEARCH_USERNAME = var.opensearch_master_username
    OPENSEARCH_PASSWORD = random_password.opensearch_master.result

    # --- Kafka / MSK (SASL/SCRAM over TLS) ---
    KAFKA_BOOTSTRAP     = aws_msk_cluster.this.bootstrap_brokers_sasl_scram
    KAFKA_SASL_USERNAME = var.kafka_sasl_username
    KAFKA_SASL_PASSWORD = random_password.kafka_scram.result

    # --- Object storage (prefer IRSA over static keys; endpoint+region here) ---
    OBJECTSTORE_ENDPOINT         = "https://s3.${var.region}.amazonaws.com"
    OBJECTSTORE_REGION           = var.region
    OBJECTSTORE_BUCKET_WAREHOUSE = aws_s3_bucket.this["warehouse"].bucket
    OBJECTSTORE_BUCKET_UPLOADS   = aws_s3_bucket.this["uploads"].bucket
    OBJECTSTORE_BUCKET_PROFILES  = aws_s3_bucket.this["profiles"].bucket
    OBJECTSTORE_BUCKET_PIPELINES = aws_s3_bucket.this["pipelines"].bucket
  }

  datacern_secret_payload = merge(var.secrets, local.computed_secrets)
}

resource "aws_secretsmanager_secret" "datacern" {
  name        = "${var.name_prefix}/datacern-secrets"
  description = "Datacern platform secrets synced into the K8s datacern-secrets Secret by External Secrets Operator."

  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "datacern" {
  secret_id     = aws_secretsmanager_secret.datacern.id
  secret_string = jsonencode(local.datacern_secret_payload)
}
