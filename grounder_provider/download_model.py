#!/usr/bin/env python3
"""Download LocateAnything-3B for the local grounding provider."""

from __future__ import annotations

import argparse
import os
from pathlib import Path

from huggingface_hub import snapshot_download


MODEL_REPO_ID = "nvidia/LocateAnything-3B"
PROVIDER_DIR = Path(__file__).resolve().parent
DEFAULT_MODEL_DIR = PROVIDER_DIR / "models" / "LocateAnything-3B"
LICENSE_URL = "https://huggingface.co/nvidia/LocateAnything-3B/blob/main/LICENSE"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Download nvidia/LocateAnything-3B into grounder_provider/models."
    )
    parser.add_argument(
        "--repo-id",
        default=MODEL_REPO_ID,
        help=f"Hugging Face repo id to download (default: {MODEL_REPO_ID})",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=DEFAULT_MODEL_DIR,
        help=f"Local model directory (default: {DEFAULT_MODEL_DIR})",
    )
    parser.add_argument(
        "--token",
        default=os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN"),
        help="Hugging Face token for gated/private downloads. Defaults to HF_TOKEN.",
    )
    parser.add_argument(
        "--accept-license",
        action="store_true",
        default=os.environ.get("LOCATEANYTHING_ACCEPT_LICENSE") == "1",
        help="Acknowledge the NVIDIA non-commercial research license.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if not args.accept_license:
        raise SystemExit(
            "LocateAnything-3B is under the NVIDIA non-commercial research license. "
            f"Review {LICENSE_URL}, then rerun with --accept-license or "
            "LOCATEANYTHING_ACCEPT_LICENSE=1."
        )

    args.output_dir.mkdir(parents=True, exist_ok=True)
    path = snapshot_download(
        repo_id=args.repo_id,
        local_dir=args.output_dir,
        token=args.token,
        ignore_patterns=[
            "assets/*",
            "*.mp4",
            "*.png",
            "*.jpg",
            "*.jpeg",
        ],
    )
    print(path)


if __name__ == "__main__":
    main()
