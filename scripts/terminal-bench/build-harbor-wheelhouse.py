from __future__ import annotations

import base64
import csv
import hashlib
import importlib.metadata
import io
import json
import os
import shutil
import sys
import zipfile
from pathlib import Path


def main() -> None:
    wheelhouse = Path(sys.argv[1]).resolve()
    manifest_path = Path(sys.argv[2]).resolve()
    pinned_harbor_wheel = Path(sys.argv[3]).resolve()
    wheelhouse.mkdir(parents=True, exist_ok=True)
    for old_wheel in wheelhouse.glob("*.whl"):
        old_wheel.unlink()

    artifacts = [
        repack_distribution(distribution, wheelhouse)
        for distribution in sorted(
            importlib.metadata.distributions(),
            key=lambda distribution: (
                distribution.metadata["Name"].lower(),
                distribution.version,
            ),
        )
    ]
    harbor_target = wheelhouse / pinned_harbor_wheel.name
    shutil.copyfile(pinned_harbor_wheel, harbor_target)
    for artifact in artifacts:
        if artifact["requirement"] == "harbor==0.20.0":
            artifact["filename"] = harbor_target.name
            artifact["sha256"] = file_sha256(harbor_target)
            break
    else:
        raise RuntimeError("The resolved environment does not contain harbor==0.20.0")

    manifest = {
        "artifacts": artifacts,
        "platform": "macos-arm64",
        "python": "3.12",
        "schemaVersion": 1,
    }
    manifest_path.write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def repack_distribution(
    distribution: importlib.metadata.Distribution,
    wheelhouse: Path,
) -> dict[str, str]:
    name = distribution.metadata["Name"]
    version = distribution.version
    distribution_info = Path(distribution._path).name
    wheel_metadata = Path(
        distribution.locate_file(Path(distribution_info) / "WHEEL")
    )
    tags = [
        line.split(":", 1)[1].strip()
        for line in wheel_metadata.read_text(encoding="utf-8").splitlines()
        if line.startswith("Tag:")
    ]
    if not tags:
        raise RuntimeError(f"Missing wheel tag for {name}=={version}")
    parsed_tags = [tag.split("-", 2) for tag in tags]
    python_tag = ".".join(dict.fromkeys(tag[0] for tag in parsed_tags))
    abi_tag = ".".join(dict.fromkeys(tag[1] for tag in parsed_tags))
    platform_tag = ".".join(dict.fromkeys(tag[2] for tag in parsed_tags))
    filename = (
        f"{name.replace('-', '_')}-{version}-{python_tag}-{abi_tag}-{platform_tag}.whl"
    )
    destination = wheelhouse / filename
    records: list[tuple[str, str, str]] = []
    with zipfile.ZipFile(
        destination,
        "w",
        compression=zipfile.ZIP_DEFLATED,
        compresslevel=9,
    ) as archive:
        for relative_path in sorted(distribution.files or [], key=str):
            parts = Path(relative_path).parts
            if (
                not parts
                or ".." in parts
                or parts[0] == "."
                or "__pycache__" in parts
                or str(relative_path).endswith(".pyc")
                or (
                    parts[0].endswith(".dist-info")
                    and parts[-1]
                    in {"INSTALLER", "REQUESTED", "direct_url.json", "RECORD"}
                )
            ):
                continue
            source = Path(distribution.locate_file(relative_path))
            if not source.is_file() or source.is_symlink():
                continue
            data = source.read_bytes()
            archive_name = str(relative_path).replace(os.sep, "/")
            write_zip_entry(archive, archive_name, data)
            digest = (
                base64.urlsafe_b64encode(hashlib.sha256(data).digest())
                .rstrip(b"=")
                .decode()
            )
            records.append((archive_name, f"sha256={digest}", str(len(data))))
        record_name = f"{distribution_info}/RECORD"
        record_buffer = io.StringIO(newline="")
        writer = csv.writer(record_buffer, lineterminator="\n")
        writer.writerows(records)
        writer.writerow((record_name, "", ""))
        write_zip_entry(archive, record_name, record_buffer.getvalue().encode())
    return {
        "filename": filename,
        "requirement": f"{name}=={version}",
        "sha256": file_sha256(destination),
    }


def write_zip_entry(archive: zipfile.ZipFile, name: str, data: bytes) -> None:
    info = zipfile.ZipInfo(name, (2020, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = (0o100644 & 0xFFFF) << 16
    archive.writestr(info, data)


def file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


if __name__ == "__main__":
    main()
