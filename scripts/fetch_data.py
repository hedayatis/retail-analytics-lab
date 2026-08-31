"""Fetch the donor-permitted Online Retail II source and verify its checksum."""
from __future__ import annotations

import hashlib
from pathlib import Path
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / "data" / "raw" / "onlineretail2.rda"
CHECKSUM = TARGET.with_suffix(".rda.sha256")
SOURCE = (
    "https://raw.githubusercontent.com/allanvc/onlineretail2/"
    "master/data/onlineretail2.rda"
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while block := handle.read(1 << 20):
            digest.update(block)
    return digest.hexdigest()


def main() -> int:
    expected = CHECKSUM.read_text(encoding="utf-8").split()[0]
    if TARGET.exists() and sha256(TARGET) == expected:
        print(f"{TARGET.relative_to(ROOT)}: checksum OK")
        return 0

    TARGET.parent.mkdir(parents=True, exist_ok=True)
    temporary = TARGET.with_suffix(".rda.download")
    try:
        print(f"downloading {SOURCE}")
        with urlopen(SOURCE, timeout=60) as response, temporary.open("wb") as out:
            while block := response.read(1 << 20):
                out.write(block)
        observed = sha256(temporary)
        if observed != expected:
            raise ValueError(
                f"checksum mismatch: expected {expected}, observed {observed}"
            )
        temporary.replace(TARGET)
    finally:
        temporary.unlink(missing_ok=True)

    print(f"{TARGET.relative_to(ROOT)}: downloaded and checksum OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
