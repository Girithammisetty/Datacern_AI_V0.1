# gpu_training_pool.tf — an OPTIONAL, scale-to-zero GPU node pool for SLM
# distillation LoRA training jobs (task #45 / design §M3). Off by default
# (enable_gpu_training_pool=false → count 0), so a normal cluster carries no
# GPU cost; when enabled it autoscales from 0, is tainted so only training Jobs
# (which tolerate it) land there, and installs the NVIDIA driver. This is the
# infra the (GPU-gated) trainer executes on — validatable with `terraform
# validate` without any GPU present.

resource "google_container_node_pool" "gpu_training" {
  count = var.enable_gpu_training_pool ? 1 : 0

  name     = "${var.name_prefix}-gpu-training"
  location = var.region
  cluster  = google_container_cluster.this.name

  autoscaling {
    min_node_count = 0 # scale to zero when no training job is queued
    max_node_count = var.gpu_training_max_count
  }

  management {
    auto_repair  = true
    auto_upgrade = true
  }

  node_config {
    machine_type = var.gpu_training_machine_type # e.g. g2-standard-8 (L4) / a2-highgpu-1g (A100)
    disk_size_gb = var.gpu_training_disk_size_gb
    disk_type    = "pd-ssd"
    spot         = var.gpu_training_spot
    image_type   = "COS_CONTAINERD"

    guest_accelerator {
      type  = var.gpu_training_accelerator_type # e.g. nvidia-l4 / nvidia-tesla-a100
      count = var.gpu_training_accelerator_count

      gpu_driver_installation_config {
        gpu_driver_version = "LATEST"
      }
    }

    service_account = google_service_account.gke_nodes.email
    oauth_scopes    = ["https://www.googleapis.com/auth/cloud-platform"]

    workload_metadata_config {
      mode = "GKE_METADATA"
    }

    shielded_instance_config {
      enable_secure_boot          = true
      enable_integrity_monitoring = true
    }

    # Only pods that explicitly tolerate the GPU taint schedule here (the SLM
    # training Job does; nothing else on the platform pays for idle GPUs).
    taint {
      key    = "nvidia.com/gpu"
      value  = "present"
      effect = "NO_SCHEDULE"
    }

    labels = merge(local.common_labels, { "windrose.ai/workload" = "slm-training" })
  }

  lifecycle {
    ignore_changes = [node_config[0].labels, node_config[0].taint]
  }
}
