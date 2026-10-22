#!/usr/bin/env python3
"""Reconstruct the animation assets from a shipped APK.

The 106 animation clips are 334 MiB of frame-baked WebP. That is far past what a
git repository should carry, so the repository ships the code and this script
re-extracts the media from an APK you already have. The result is byte-identical
to what the APK runs on — the files are read straight out of the ZIP, never
re-encoded.

Usage
-----
    python tools/extract-assets.py --apk dsh-pet-android.apk --verify
    python tools/extract-assets.py --apk dsh-pet-android.apk --output android/app/src/main/assets/web/assets

By default the script writes into `android/app/src/main/assets/web/assets`, which
is where the Gradle build expects the media to live.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / "android/app/src/main/assets/web/assets"

#: Everything the page actually loads lives under this prefix inside the APK.
APK_ASSET_PREFIX = "assets/web/assets/"

#: The manifest travels with the repository; it is the single source of truth for
#: clip ids, frame counts, body/head boxes and the sound table.
MANIFEST = "manifest.json"
MANIFEST_JS = "manifest.js"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def collect(apk: Path) -> dict[str, zipfile.ZipInfo]:
    with zipfile.ZipFile(apk) as archive:
        entries = {
            info.filename[len(APK_ASSET_PREFIX):]: info
            for info in archive.infolist()
            if info.filename.startswith(APK_ASSET_PREFIX) and not info.is_dir()
        }
    if not entries:
        raise SystemExit(
            f"{apk} has nothing under {APK_ASSET_PREFIX!r}. "
            "Is this really the full-edition APK?"
        )
    return entries


def read_manifest(archive_path: Path) -> dict:
    with zipfile.ZipFile(archive_path) as archive:
        with archive.open(APK_ASSET_PREFIX + MANIFEST) as handle:
            return json.load(handle)


def extract(apk: Path, output: Path, verify: bool) -> int:
    manifest = read_manifest(apk)
    clips = manifest["clips"]
    declared = {clip["file"]: clip for clip in clips}

    with zipfile.ZipFile(apk) as archive:
        entries = collect(apk)
        missing = [name for name in declared if name not in entries]
        if missing:
            raise SystemExit(
                f"manifest declares {len(missing)} clip(s) the APK does not carry, "
                f"first few: {missing[:5]}"
            )

        total = 0
        written = 0
        for name in sorted(entries):
            info = entries[name]
            target = output / name
            target.parent.mkdir(parents=True, exist_ok=True)
            data = archive.read(info)
            target.write_bytes(data)
            total += len(data)
            written += 1

            if verify and name in declared:
                clip = declared[name]
                if len(data) != clip["bytes"]:
                    raise SystemExit(
                        f"{name}: extracted {len(data)} B but the manifest declares "
                        f"{clip['bytes']} B — this APK is not the version the manifest "
                        "describes"
                    )

    frames = sum(clip["frames"] for clip in clips)
    print(json.dumps({
        "clips": len(clips),
        "frames": frames,
        "files_written": written,
        "bytes": total,
        "output": str(output),
        "verified": bool(verify),
    }, ensure_ascii=False, indent=2))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apk", type=Path, required=True,
                        help="path to the shipped APK")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT,
                        help=f"where to unpack the media (default: {DEFAULT_OUTPUT})")
    parser.add_argument("--verify", action="store_true",
                        help="cross-check every clip's byte count against the manifest")
    args = parser.parse_args(argv)

    apk = args.apk.expanduser().resolve()
    if not apk.is_file():
        raise SystemExit(f"no such APK: {apk}")
    return extract(apk, args.output.expanduser().resolve(), args.verify)


if __name__ == "__main__":
    sys.exit(main())
