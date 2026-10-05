#!/usr/bin/env python3
"""Return bounded, credential-free build telemetry from the Depot host."""

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import sys


STAGES = ("bootstrap", "build", "policy-non-ab", "inspect-non-ab", "upload-non-ab",
          "policy-ab", "inspect-ab", "upload-ab", "pipeline")
LAYOUTS = ("non-ab", "ab")
PRODUCTS = frozenset(("virtio_arm64only", "virtio_x86_64"))
VARIANTS = frozenset(("user", "userdebug"))
PROGRESS = re.compile(r"\[\s*(\d+)%\s+(\d+)/(\d+)")
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
GENERIC_COMPILER_FAILURE = "Compiler reported a failure. See the private build logs for details."
FAILURE_DETAILS = {
    "bootstrap": ("Builder setup failed", "Builder setup failed (exit code {code})."),
    "build": ("Image build failed", "Image build failed (exit code {code})."),
    "policy-non-ab": ("Policy check failed · non-A/B", "Policy check failed for non-A/B release (exit code {code})."),
    "inspect-non-ab": ("Image checks failed · non-A/B", "Image checks failed for non-A/B release (exit code {code})."),
    "upload-non-ab": ("Upload failed · non-A/B", "Upload failed for non-A/B release (exit code {code})."),
    "policy-ab": ("Policy check failed · A/B", "Policy check failed for A/B release (exit code {code})."),
    "inspect-ab": ("Image checks failed · A/B", "Image checks failed for A/B release (exit code {code})."),
    "upload-ab": ("Upload failed · A/B", "Upload failed for A/B release (exit code {code})."),
    "pipeline": ("Build pipeline failed", "Build pipeline failed (exit code {code})."),
}


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _clean_progress(value):
    if not isinstance(value, dict):
        return None
    percent, done, total = (value.get(key) for key in ("percent", "done", "total"))
    if not all(_is_int(item) for item in (percent, done, total)):
        return None
    if not 0 <= percent <= 100 or done < 0 or total < done:
        return None
    return {"percent": percent, "done": done, "total": total}


def _empty_state():
    return {"offset": 0, "log_identity": None, "recent": [], "compiler_failure": False}


def _read_state(state_file):
    try:
        saved = json.loads(state_file.read_text())
    except (OSError, ValueError):
        saved = {}
    if not isinstance(saved, dict) or "log_identity" not in saved:
        return _empty_state()

    identity = saved.get("log_identity")
    if identity is not None and not (
        isinstance(identity, list) and len(identity) == 2 and
        all(_is_int(item) and item >= 0 for item in identity)
    ):
        return _empty_state()

    state = _empty_state()
    state["log_identity"] = identity
    offset = saved.get("offset")
    if _is_int(offset) and offset >= 0:
        state["offset"] = offset
    if saved.get("layout") in LAYOUTS:
        state["layout"] = saved["layout"]
    variant = saved.get("variant")
    if isinstance(variant, str) and variant in VARIANTS:
        state["variant"] = variant
    progress = _clean_progress(saved.get("progress"))
    if progress:
        state["progress"] = progress
    state["compiler_failure"] = saved.get("compiler_failure") is True

    recent = saved.get("recent")
    if isinstance(recent, list):
        state["recent"] = [
            progress for item in recent
            if (progress := _clean_progress(item)) is not None
        ][-6:]
    return state


def _resolve_product(root, requested):
    if requested is not None:
        if not isinstance(requested, str) or requested not in PRODUCTS:
            raise ValueError("unsupported product")
        return requested

    try:
        metadata = json.loads((root / ".lutm-build.json").read_text())
    except (OSError, ValueError):
        metadata = {}
    product = metadata.get("product") if isinstance(metadata, dict) else None
    return product if isinstance(product, str) and product in PRODUCTS else "virtio_arm64only"


def _release_is_built(root, product, layout):
    release = root / "android/lineage/out/releases" / product / layout / "release.json"
    try:
        metadata = json.loads(release.read_text())
    except (OSError, ValueError):
        return False
    return (
        isinstance(metadata, dict) and
        metadata.get("product") == product and
        metadata.get("partition_layout") == layout
    )


def _post_steps_started(root, markers, layout):
    for stage in ("policy", "inspect", "upload"):
        key = f"{stage}-{layout}"
        if key in markers or (root / f"{key}.log").is_file():
            return True
    return False


def _downloads(root, layout):
    downloads = []
    try:
        lines = (root / f"upload-{layout}.log").read_text().splitlines()
    except OSError:
        return downloads
    name = None
    for line in lines:
        match = re.match(r'\s*(".*") \((\d+) bytes, MD5 ', line)
        if match:
            try:
                name = json.loads(match.group(1))
            except ValueError:
                name = None
        url = re.fullmatch(r"\s*(?:folder: )?(https://gofile\.io/d/[A-Za-z0-9-]+)\s*", line)
        if name and url:
            if line.strip().startswith("folder:") and downloads:
                downloads[-1]["url"] = url.group(1)
            elif not line.strip().startswith("folder:"):
                downloads.append({"name": name, "url": url.group(1)})
    return downloads


def _failure(markers, compiler_failure):
    for stage in STAGES:
        code = markers.get(stage)
        if code is not None and code != 0:
            label, message = FAILURE_DETAILS[stage]
            return stage, label, message.format(code=code)
    if compiler_failure:
        return "build", FAILURE_DETAILS["build"][0], GENERIC_COMPILER_FAILURE
    return None, None, None


def _activity_summary(progress):
    return f"Build actions: {progress['percent']}% ({progress['done']}/{progress['total']})"


def collect(root, product=None):
    root = Path(root)
    product = _resolve_product(root, product)
    state_file = root / ".lutm-status.json"
    state = _read_state(state_file)
    markers = {}
    for stage in STAGES:
        try:
            markers[stage] = int((root / f"{stage}.exit").read_text().strip())
        except (OSError, ValueError):
            pass

    log = root / "build.log"
    log_updated = None
    if log.is_file():
        with log.open("rb") as stream:
            info = os.fstat(stream.fileno())
            identity = [info.st_dev, info.st_ino]
            if identity != state.get("log_identity") or info.st_size < state.get("offset", 0):
                state = _empty_state()
            state["log_identity"] = identity
            recent = list(state.get("recent", []))
            stream.seek(state.get("offset", 0))
            for raw in stream:
                line = ANSI.sub("", raw.decode("utf8", "replace")).strip()
                if line.startswith("OUT_DIR="):
                    value = line.partition("=")[2].strip().rstrip("/")
                    layout = value.rsplit("/", 1)[-1]
                    if layout in LAYOUTS:
                        state.pop("progress", None)
                        state["compiler_failure"] = False
                        recent.clear()
                        state["layout"] = layout
                if line.startswith("TARGET_BUILD_VARIANT="):
                    variant = line.partition("=")[2].strip()
                    if variant in VARIANTS:
                        state["variant"] = variant
                    else:
                        state.pop("variant", None)
                match = PROGRESS.search(line)
                if match:
                    try:
                        progress = _clean_progress(dict(zip(
                            ("percent", "done", "total"), map(int, match.groups())
                        )))
                    except ValueError:
                        progress = None
                    if progress:
                        state["progress"] = progress
                        recent.append(progress)
                        recent = recent[-6:]
                elif line.startswith("FAILED:"):
                    state["compiler_failure"] = True
            state["offset"] = stream.tell()
            state["recent"] = recent[-6:]
            log_updated = datetime.fromtimestamp(info.st_mtime, timezone.utc).isoformat()
    elif state.get("log_identity") is not None:
        state = _empty_state()

    state_file.write_text(json.dumps(state))
    bootstrap_failed = markers.get("bootstrap", 0) != 0
    builds = {layout: _release_is_built(root, product, layout) for layout in LAYOUTS}
    layouts = []
    post_processing_started = False

    for layout in LAYOUTS:
        built = builds[layout]
        post_started = _post_steps_started(root, markers, layout)
        post_processing_started |= post_started
        build_failed = markers.get("build") not in (None, 0) and state.get("layout") == layout
        compiler_failed = state.get("compiler_failure", False) and state.get("layout") == layout
        steps = []

        if bootstrap_failed:
            steps = [{"label": label, "status": "pending"} for label in
                     ("Images", "Policy", "Image checks", "Upload")]
            status = "blocked"
        else:
            if build_failed or compiler_failed:
                image_status = "failed"
            elif built:
                image_status = "passed"
            elif state.get("layout") == layout and "build" not in markers:
                image_status = "running"
            else:
                image_status = "pending"
            steps.append({"label": "Images", "status": image_status})
            for stage, label in (("policy", "Policy"), ("inspect", "Image checks"), ("upload", "Upload")):
                key = f"{stage}-{layout}"
                if key in markers:
                    step_status = "passed" if markers[key] == 0 else "failed"
                elif (root / f"{key}.log").is_file():
                    step_status = "running"
                else:
                    step_status = "pending"
                steps.append({"label": label, "status": step_status})

            local_failure = (
                build_failed or compiler_failed or
                any(markers.get(f"{stage}-{layout}") not in (None, 0)
                    for stage in ("policy", "inspect", "upload"))
            )
            complete_evidence = (
                not local_failure and built and markers.get("bootstrap") == 0 and
                markers.get("build") == 0 and
                all(markers.get(f"{stage}-{layout}") == 0
                    for stage in ("policy", "inspect", "upload"))
            )
            build_only_evidence = (
                not local_failure and built and markers.get("bootstrap") == 0 and
                markers.get("build") == 0 and not post_started
            )
            if local_failure:
                status = "failed"
            elif complete_evidence:
                status = "complete"
            elif build_only_evidence:
                status = "built"
            elif post_started or markers.get("build") == 0:
                status = "checking"
            elif state.get("layout") == layout:
                status = "building"
            else:
                status = "queued"

        downloads = _downloads(root, layout) if status == "complete" else []
        layouts.append({"id": layout, "status": status, "steps": steps, "downloads": downloads,
                        "progress": state.get("progress") if not bootstrap_failed and state.get("layout") == layout and not built else None})

    failed_stage, failure_stage, failure = _failure(markers, state.get("compiler_failure", False))
    failed = failed_stage is not None
    all_built = all(builds.values())
    all_complete = all(layout["status"] == "complete" for layout in layouts)
    build_only = (
        not failed and markers.get("bootstrap") == 0 and markers.get("build") == 0 and
        all_built and not post_processing_started and "pipeline" not in markers
    )

    if failed:
        stage = failure_stage
        status = "failed"
    elif all_complete and markers.get("pipeline") == 0:
        stage = "Complete"
        status = "complete"
    elif build_only:
        stage = "Images built · uploads not started"
        status = "built"
    else:
        status = "running"
        if markers.get("pipeline") == 0:
            stage = "Release completion evidence incomplete"
        elif "bootstrap" not in markers:
            stage = "Preparing builder"
        elif markers.get("build") == 0:
            stage = "Verifying and uploading releases" if all_built else "Checking build outputs"
        elif not state.get("layout"):
            stage = "Syncing sources"
        elif state.get("layout") == "ab":
            stage = "Building A/B"
        elif state.get("variant") == "userdebug":
            stage = "Building non-A/B recovery"
        else:
            stage = "Building non-A/B"

    return {"sampledAt": datetime.now(timezone.utc).isoformat(), "stage": stage,
            "status": status, "product": product, "layouts": layouts,
            "recent": [_activity_summary(progress) for progress in state.get("recent", [])],
            "failure": failure, "logUpdatedAt": log_updated}


if __name__ == "__main__":
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.home()
    product = sys.argv[2] if len(sys.argv) > 2 else None
    print(json.dumps(collect(root, product)))
