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

#: The 6-clip development stub sits next to it and uses Chinese file names.
APK_STUB_PREFIX = "assets/web/assets-stub/"

#: The manifest travels with the repository; it is the single source of truth for
#: clip ids, frame counts, body/head boxes and the sound table.
MANIFEST = "manifest.json"
MANIFEST_JS = "manifest.js"


def decode_name(info: zipfile.ZipInfo) -> str:
    """Undo zipfile's cp437 guess for entries that carry no UTF-8 flag.

    The shipped APK writes Chinese file names into the ZIP without setting the
    UTF-8 flag (bit 0x800), so `ZipInfo.filename` comes back mojibake such as
    ``idle__σ╛àµ£║σæ╝σÉ╕Σ╝æΘù▓.webp``. The bytes are really UTF-8; encoding back
    to cp437 and decoding as UTF-8 recovers ``idle__待机呼吸休闲.webp`` — which is
    exactly what `assets-stub/manifest.json` references. Getting this wrong makes
    every stub clip 404.
    """
    name = info.filename
    if info.flag_bits & 0x800:
        return name
    try:
        return name.encode("cp437").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return name  # plain ASCII, or genuinely not UTF-8: leave it alone


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def collect(apk: Path, prefix: str) -> dict[str, zipfile.ZipInfo]:
    with zipfile.ZipFile(apk) as archive:
        entries = {
            decode_name(info)[len(prefix):]: info
            for info in archive.infolist()
            if info.filename.startswith(prefix) and not info.is_dir()
        }
    if not entries:
        raise SystemExit(
            f"{apk} has nothing under {prefix!r}. "
            "Is this really the full-edition APK?"
        )
    return entries


def read_manifest(archive_path: Path) -> dict:
    with zipfile.ZipFile(archive_path) as archive:
        with archive.open(APK_ASSET_PREFIX + MANIFEST) as handle:
            return json.load(handle)


def write_entries(archive: zipfile.ZipFile, entries: dict[str, zipfile.ZipInfo],
                  output: Path, declared: dict | None = None,
                  verify: bool = False) -> tuple[int, int]:
    total = 0
    for name in sorted(entries):
        info = entries[name]
        target = output / name
        target.parent.mkdir(parents=True, exist_ok=True)
        data = archive.read(info)
        target.write_bytes(data)
        total += len(data)
        if verify and declared and name in declared:
            clip = declared[name]
            if len(data) != clip["bytes"]:
                raise SystemExit(
                    f"{name}: extracted {len(data)} B but the manifest declares "
                    f"{clip['bytes']} B — this APK is not the version the manifest "
                    "describes"
                )
    return total, len(entries)


def extract(apk: Path, output: Path, verify: bool, with_stub: bool) -> int:
    manifest = read_manifest(apk)
    clips = manifest["clips"]
    declared = {clip["file"]: clip for clip in clips}

    with zipfile.ZipFile(apk) as archive:
        entries = collect(apk, APK_ASSET_PREFIX)
        missing = [name for name in declared if name not in entries]
        if missing:
            raise SystemExit(
                f"manifest declares {len(missing)} clip(s) the APK does not carry, "
                f"first few: {missing[:5]}"
            )
        total, written = write_entries(archive, entries, output, declared, verify)

        stub = {"clips": 0, "files_written": 0, "bytes": 0}
        if with_stub:
            stub_target = output.parent / "assets-stub"
            stub_entries = collect(apk, APK_STUB_PREFIX)
            stub_bytes, stub_written = write_entries(archive, stub_entries, stub_target)
            stub = {
                "clips": len(stub_entries),
                "files_written": stub_written,
                "bytes": stub_bytes,
                "output": str(stub_target),
            }

    frames = sum(clip["frames"] for clip in clips)
    print(json.dumps({
        "clips": len(clips),
        "frames": frames,
        "files_written": written,
        "bytes": total,
        "output": str(output),
        "verified": bool(verify),
        "stub": stub,
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
    parser.add_argument("--no-stub", action="store_true",
                        help="skip the 6-clip development stub (assets-stub/)")
    args = parser.parse_args(argv)

    apk = args.apk.expanduser().resolve()
    if not apk.is_file():
        raise SystemExit(f"no such APK: {apk}")
    return extract(apk, args.output.expanduser().resolve(), args.verify,
                   not args.no_stub)


if __name__ == "__main__":
    sys.exit(main())
