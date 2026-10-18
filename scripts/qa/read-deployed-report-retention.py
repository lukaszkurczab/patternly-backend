#!/usr/bin/env python3
"""Read Cloud Run routing, pinned image code and TTL metadata; never execute the image.

Usage: python3 scripts/qa/read-deployed-report-retention.py PROJECT REGION SERVICE OUTPUT
Requires existing gcloud authorization, curl and an unused private OUTPUT directory.
Only the single revision receiving 100% traffic is inspected. Tagged revisions are
recorded as separate, uninspected targets. This is evidence collection, not legal
approval or an automatic retention verdict. No API is enabled and no records read.
"""
import datetime
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile


def require(condition, stage):
    if not condition:
        raise RuntimeError(stage)


def run(arguments, stage, data=None):
    result = subprocess.run(arguments, input=data, capture_output=True, timeout=60)
    require(result.returncode == 0, stage)
    return result.stdout


def sha(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


def main():
    require(len(sys.argv) == 5, "USAGE_PROJECT_REGION_SERVICE_PRIVATE_OUTPUT")
    project, region, service, destination = sys.argv[1:]
    require(all(re.fullmatch(r"[a-z][a-z0-9-]+", item) for item in [project, region, service]), "INVALID_TARGET")
    output = Path(destination).resolve()
    workspace = Path(__file__).resolve().parents[3]
    private_roots = [workspace / ".agent/private", Path("/private/tmp"), Path("/tmp").resolve()]
    require(any(root in output.parents for root in private_roots), "OUTPUT_MUST_BE_PRIVATE")
    os.umask(0o077)
    output.mkdir(parents=True, exist_ok=False)

    def save(name, value):
        (output / name).write_text(json.dumps(value, indent=2) + "\n")

    def cloud(arguments, stage, fields):
        return json.loads(run(["gcloud", *arguments, "--project=" + project,
                               "--format=json(" + fields + ")", "--quiet"], stage))

    observed = datetime.datetime.now(datetime.timezone.utc).isoformat()
    raw = cloud(["run", "services", "describe", service, "--region=" + region],
                "SERVICE_READ_UNAVAILABLE", "status.traffic")
    traffic = raw["status"]["traffic"]
    routes = [{key: row[key] for key in ["revisionName", "percent", "tag"] if key in row} for row in traffic]
    active = [row for row in routes if row.get("percent", 0) > 0]
    require(len(active) == 1 and active[0]["percent"] == 100, "SPLIT_TRAFFIC_REQUIRES_SEPARATE_REVIEW")
    revision = cloud(["run", "revisions", "describe", active[0]["revisionName"], "--region=" + region],
                     "REVISION_READ_UNAVAILABLE", "spec.containers[].command,spec.containers[].args,spec.containers[].env[].name,status.imageDigest")
    containers = revision["spec"]["containers"]
    require(len(containers) == 1, "MULTI_CONTAINER_REQUIRES_SEPARATE_REVIEW")
    container = containers[0]
    require(not container.get("command") and not container.get("args"), "RUNTIME_COMMAND_OVERRIDE")
    relevant_names = {"REPORT_RATE_LIMIT_WINDOW_SECONDS", "NODE_OPTIONS", "NODE_PATH"}
    overrides = [entry for entry in container.get("env", []) if entry["name"] in relevant_names]
    # Do not read secret versions. An override, even a literal one, needs explicit review.
    require(not overrides, "RUNTIME_ENV_OVERRIDE_REQUIRES_SEPARATE_REVIEW")
    image = revision["status"]["imageDigest"]
    match = re.fullmatch(r"([a-z0-9-]+-docker\.pkg\.dev)/([a-z0-9/_-]+)@(sha256:[a-f0-9]{64})", image)
    require(match is not None, "UNSUPPORTED_OR_UNPINNED_IMAGE")
    host, repository, digest = match.groups()
    save("routing.json", {"observedAtUtc": observed, "project": project, "region": region, "service": service,
                          "routes": routes, "inspectedRevision": active[0]["revisionName"], "image": image,
                          "runtimeOverrides": False, "otherTaggedImagesInspected": False})
    token = run(["gcloud", "auth", "print-access-token", "--quiet"], "AUTH_READ_UNAVAILABLE").decode().strip()
    require(re.fullmatch(r"[A-Za-z0-9._~-]+", token) is not None, "UNSUPPORTED_TOKEN_ENCODING")

    def get(kind, expected_digest, expected_size=None):
        require(re.fullmatch(r"sha256:[a-f0-9]{64}", expected_digest) is not None, "INVALID_DESCRIPTOR")
        # Authorization only in process memory/stdin, never argv, output or a file.
        config = ('header = "Authorization: Bearer ' + token + '"\n'
                  'header = "Accept: application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json"\n')
        data = run(["curl", "--config", "-", "--silent", "--show-error", "--fail", "--location",
                    "--proto", "=https", "--proto-redir", "=https", "--max-filesize", "2000000", "--max-time", "45",
                    f"https://{host}/v2/{repository}/{kind}/{expected_digest}"], "REGISTRY_GET_UNAVAILABLE", config.encode())
        require(len(data) <= 2_000_000 and sha(data) == expected_digest, "REGISTRY_DIGEST_MISMATCH")
        require(expected_size is None or len(data) == expected_size, "REGISTRY_SIZE_MISMATCH")
        return data

    manifest_bytes = get("manifests", digest)
    manifest = json.loads(manifest_bytes)
    require(manifest.get("schemaVersion") == 2 and "layers" in manifest, "UNSUPPORTED_IMAGE_MANIFEST")
    (output / "image-manifest.json").write_bytes(manifest_bytes)
    descriptor = manifest["config"]
    config_bytes = get("blobs", descriptor["digest"], descriptor["size"])
    config = json.loads(config_bytes)
    runtime = config["config"]
    require(runtime.get("WorkingDir") == "/app" and runtime.get("Cmd") == ["node", "dist/index.js"]
            and runtime.get("Entrypoint") == ["docker-entrypoint.sh"], "UNEXPECTED_IMAGE_ENTRYPOINT")
    require(not any(entry.split("=", 1)[0] in relevant_names for entry in runtime.get("Env", [])), "IMAGE_ENV_OVERRIDE")
    filesystem_history = [row for row in config["history"] if not row.get("empty_layer", False)]
    require(len(filesystem_history) == len(manifest["layers"])
            and re.search(r"COPY .*?(?:/app/dist|in \./dist)\s*(?:# buildkit)?$",
                          filesystem_history[-1].get("created_by", "")), "DIST_NOT_LAST_FILESYSTEM_LAYER")
    # Raw config remains private; it is needed to verify entrypoint/layer correspondence.
    (output / "image-config.json").write_bytes(config_bytes)
    layer = manifest["layers"][-1]
    require(layer["size"] < 2_000_000, "DIST_LAYER_TOO_LARGE_FOR_BOUNDED_READ")
    layer_bytes = get("blobs", layer["digest"], layer["size"])
    (output / "dist-layer.tar.gz").write_bytes(layer_bytes)
    paths = ["index.js", "config/environment.js", "infrastructure/firestore/stores.js", "api/app.js",
             "modules/content-reports/contracts.js", "modules/content-reports/store.js"]
    files = []
    with gzip.GzipFile(fileobj=io.BytesIO(layer_bytes)) as compressed:
        uncompressed = compressed.read(16_000_001)
    require(len(uncompressed) <= 16_000_000, "DIST_LAYER_UNCOMPRESSED_LIMIT")
    with tarfile.open(fileobj=io.BytesIO(uncompressed), mode="r:") as archive:
        members = []
        for member in archive:
            members.append(member)
            require(len(members) <= 2_000, "DIST_LAYER_MEMBER_LIMIT")
        for relative in paths:
            matches = [member for member in members if member.name == "app/dist/" + relative]
            require(len(matches) == 1 and matches[0].isfile() and matches[0].size < 2_000_000, "EXPECTED_CODE_FILE_UNAVAILABLE")
            data = archive.extractfile(matches[0]).read()
            target = output / "image-dist" / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            files.append({"path": relative, "bytes": len(data), "sha256": sha(data)})
    ttl = cloud(["firestore", "fields", "ttls", "list", "--database=(default)"],
                "TTL_METADATA_READ_UNAVAILABLE", "name,ttlConfig")
    save("ttl.json", [{"name": row["name"], "ttlConfig": row.get("ttlConfig")} for row in ttl
                      if any("/collectionGroups/" + group + "/fields/expiresAt" in row["name"]
                             for group in ["rateLimitBuckets", "deletedIdentities", "contentReports"])])
    save("receipt.json", {"observedAtUtc": observed, "readOnly": True, "userRecordsRead": False,
                          "imageExecuted": False, "legalApproval": False, "image": image,
                          "manifestDigestVerified": digest, "configDigestVerified": descriptor["digest"],
                          "distLayerDigestVerified": layer["digest"], "files": files,
                          "interpretation": "Inspect saved code and TTL metadata; no automatic retention verdict."})
    print("READ_ONLY_EVIDENCE_RECORDED; legal approval and retention interpretation remain separate")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Never echo subprocess stderr, tokens, environment or provider response bodies.
        stage = str(error) if type(error) is RuntimeError else type(error).__name__
        print("READ_ONLY_EVIDENCE_FAILED stage=" + stage, file=sys.stderr)
        sys.exit(1)
