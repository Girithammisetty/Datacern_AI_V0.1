# gpu_training_pool.tf — OPTIONAL scale-to-zero GPU node pool for SLM
# distillation LoRA training (task #45 / §M3). Off by default; when enabled it
# autoscales from 0 and is tainted so only the training Job schedules on it.
# Validatable with `terraform validate` — no GPU required.

resource "azurerm_kubernetes_cluster_node_pool" "gpu_training" {
  count = var.enable_gpu_training_pool ? 1 : 0

  name                  = "gputrain"
  kubernetes_cluster_id = azurerm_kubernetes_cluster.this.id
  vm_size               = var.gpu_training_vm_size # e.g. Standard_NC4as_T4_v3 / Standard_NC24ads_A100_v4

  enable_auto_scaling = true
  min_count           = 0 # scale to zero when idle
  max_count           = var.gpu_training_max_count
  os_disk_size_gb     = var.gpu_training_disk_size_gb
  priority            = var.gpu_training_spot ? "Spot" : "Regular"
  eviction_policy     = var.gpu_training_spot ? "Delete" : null
  spot_max_price      = var.gpu_training_spot ? -1 : null

  # Only pods tolerating this taint (the SLM training Job) land on GPU nodes.
  node_taints = ["nvidia.com/gpu=present:NoSchedule"]
  node_labels = { "windrose.ai/workload" = "slm-training" }

  tags = local.common_tags

  lifecycle {
    ignore_changes = [node_count]
  }
}
