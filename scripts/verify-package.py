#!/usr/bin/env python3
"""Validate the tested extension archive before it becomes a release asset."""

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import sys
import zipfile


def verify(root: Path, tag: str = "") -> Path:
    package = json.loads((root / "package.json").read_text())
    lock = json.loads((root / "package-lock.json").read_text())
    version = package["version"]
    if not re.fullmatch(r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)", version):
        raise ValueError("Use a stable three-part version, for example 0.1.0.")
    if any(int(part) > 65535 for part in version.split(".")) or version == "0.0.0":
        raise ValueError("Version is outside Chrome's supported range.")
    if tag and tag != f"v{version}":
        raise ValueError(f"Tag {tag!r} must match package version v{version}.")
    if lock.get("version") != version or lock.get("packages", {}).get("", {}).get("version") != version:
        raise ValueError("package-lock.json version differs from package.json.")

    output = root / ".output"
    build = output / "chrome-mv3"
    manifest = json.loads((build / "manifest.json").read_text())
    if manifest.get("manifest_version") != 3 or manifest.get("version") != version:
        raise ValueError("Built manifest must be Manifest V3 with the package version.")
    archive = output / f"websitestars-{version}-chrome.zip"
    if sorted(output.glob("websitestars-*-chrome.zip")) != [archive]:
        raise ValueError("Expected exactly one Chrome archive matching the package version.")
    with zipfile.ZipFile(archive) as zipped:
        if zipped.testzip():
            raise ValueError("Archive integrity check failed.")
        names = zipped.namelist()
        if len(names) != len(set(names)):
            raise ValueError("Archive contains duplicate entries.")
        files = set()
        for name in names:
            path = PurePosixPath(name)
            if path.is_absolute() or ".." in path.parts or "\\" in name:
                raise ValueError(f"Invalid archive entry: {name}")
            if name.endswith("/"):
                continue
            files.add(name)
            if zipped.read(name) != (build / name).read_bytes():
                raise ValueError(f"Archive differs from the tested build: {name}")
        built_files = {path.relative_to(build).as_posix() for path in build.rglob("*") if path.is_file()}
        if files != built_files:
            raise ValueError("Archive and tested build must contain the same files.")
        required = {"manifest.json", "background.js", "library.html", "sidepanel.html", "options.html"}
        if not required.issubset(files):
            raise ValueError("Archive is missing an extension entry point.")

    checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
    (output / "SHA256SUMS").write_text(f"{checksum}  {archive.name}\n")
    return archive


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", default="", help="Require an exact vX.Y.Z release tag")
    args = parser.parse_args()
    try:
        archive = verify(Path(__file__).resolve().parent.parent, args.tag)
    except (ValueError, OSError, KeyError, zipfile.BadZipFile) as error:
        print(f"Package verification failed: {error}", file=sys.stderr)
        sys.exit(1)
    print(f"Verified {archive.name}; wrote .output/SHA256SUMS")
