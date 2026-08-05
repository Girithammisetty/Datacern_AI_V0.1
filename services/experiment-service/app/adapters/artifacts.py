"""Signed artifact-URL generation (EXP-FR-014).

The artifacts *index* (paths + sizes) is mirrored; the bytes are not. A read for
artifact content resolves the mirrored ``artifact_uri`` + relative path to a
short-lived presigned GET URL against object storage (MinIO S3). The local
signer is the unit-tier double (HMAC pseudo-URL).
"""

from __future__ import annotations

import asyncio
import hmac
import json
import time
from hashlib import sha256
from urllib.parse import urlparse


class ArtifactTooLarge(Exception):
    """An artifact exceeded the in-request read cap. Raised, not swallowed: a blob
    that outgrew its budget is a real condition someone must see."""


class S3ArtifactSigner:
    """Real presigned GET URLs via botocore against MinIO."""

    def __init__(self, *, endpoint_url: str, access_key: str, secret_key: str,
                 region: str, default_bucket: str = "mlflow"):
        import boto3
        from botocore.client import Config as BotoConfig

        self.default_bucket = default_bucket
        self._client = boto3.client(
            "s3", endpoint_url=endpoint_url, aws_access_key_id=access_key,
            aws_secret_access_key=secret_key, region_name=region,
            config=BotoConfig(signature_version="s3v4", s3={"addressing_style": "path"}),
        )

    def _resolve(self, artifact_uri: str, path: str) -> tuple[str, str]:
        parsed = urlparse(artifact_uri)
        if parsed.scheme == "s3":
            bucket = parsed.netloc
            prefix = parsed.path.lstrip("/")
        else:
            # mlflow-artifacts:/<exp>/<run>/artifacts -> default bucket
            bucket = self.default_bucket
            prefix = parsed.path.lstrip("/")
        key = f"{prefix.rstrip('/')}/{path.lstrip('/')}"
        return bucket, key

    async def signed_url(self, artifact_uri: str, path: str, ttl_seconds: int) -> str:
        bucket, key = self._resolve(artifact_uri, path)
        return await asyncio.to_thread(
            self._client.generate_presigned_url, "get_object",
            Params={"Bucket": bucket, "Key": key}, ExpiresIn=ttl_seconds,
        )

    async def fetch_json(self, artifact_uri: str, path: str,
                         max_bytes: int = 4 << 20) -> dict | None:
        """BRD 72 inc3b — read a small JSON artifact out of the run's artifact store.

        This is an OBJECT-STORE read, not an MLflow read: the "never call MLflow in
        the request path" invariant is about the tracking server, and dataset-service
        already reads `profile.json` from its own object store the same way.

        Returns None — never raises — when the object is absent, too large or not
        JSON. A run that predates the artifact, or whose blob was GC'd, must still
        serve its mirrored metrics rather than failing the whole chart.
        """
        bucket, key = self._resolve(artifact_uri, path)

        def _get():
            try:
                obj = self._client.get_object(Bucket=bucket, Key=key)
            except self._client.exceptions.NoSuchKey:
                # The ONLY silent case, and it is not an error: runs predating the
                # artifact, and runs whose object the retention sweep removed,
                # legitimately have no evaluation.json.
                return None
            # Everything else — a wrong endpoint, an expired key, a denied policy,
            # an unreachable store — is a REAL failure. Swallowing it here would
            # make a misconfigured object store indistinguishable from "this run
            # has no artifact", and the chart would render a confident empty state
            # over a broken deployment. Let it raise.
            size = int(obj.get("ContentLength") or 0)
            if size > max_bytes:
                raise ArtifactTooLarge(
                    f"{key} is {size} bytes, over the {max_bytes} read cap")
            return json.loads(obj["Body"].read(max_bytes))

        return await asyncio.to_thread(_get)


class LocalArtifactSigner:
    """Unit-tier HMAC pseudo-URL signer (never wired from app.main)."""

    def __init__(self, secret: str = "dev-artifact-secret"):
        self._secret = secret.encode()

    async def signed_url(self, artifact_uri: str, path: str, ttl_seconds: int) -> str:
        expires = int(time.time()) + ttl_seconds
        sig = hmac.new(self._secret, f"{artifact_uri}/{path}:{expires}".encode(),
                       sha256).hexdigest()[:32]
        return (f"https://artifacts.datacern.local/{artifact_uri}/{path}"
                f"?expires={expires}&sig={sig}")

    async def fetch_json(self, artifact_uri: str, path: str,
                         max_bytes: int = 4 << 20) -> dict | None:
        """No object store in the unit tier. Returns None — the same answer a
        genuinely absent object gives — because there is nothing to read, not
        because a failure is being hidden."""
        return None
