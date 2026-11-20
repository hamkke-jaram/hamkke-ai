"""Download only the ESC-10 clips with permissive original-clip credits."""
import csv
import hashlib
import io
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import re
import time
from urllib.request import Request, urlopen

REVISION = "33c8ce9eb2cf0b1c2f8bcf322eb349b6be34dbb6"
BASE = f"https://raw.githubusercontent.com/karolpiczak/ESC-50/{REVISION}/"
ROOT = Path(__file__).resolve().parent / "esc10"


def fetch(url):
    for attempt in range(4):
        try:
            request = Request(url, headers={"User-Agent": "HamkkeJaram-ESC10-evaluation"})
            with urlopen(request, timeout=45) as response:
                return response.read()
        except OSError:
            if attempt == 3:
                raise
            time.sleep(2 ** attempt)


def git_blob(data):
    return hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()


def main():
    (ROOT / "wav").mkdir(parents=True, exist_ok=True)
    tree_url = f"https://api.github.com/repos/karolpiczak/ESC-50/git/trees/{REVISION}?recursive=1"
    tree = json.loads(fetch(tree_url))
    assert not tree["truncated"]
    hashes = {entry["path"]: entry["sha"] for entry in tree["tree"]}
    for key, name in [("meta/esc50.csv", "esc50.csv"), ("LICENSE", "LICENSE")]:
        data = fetch(BASE + key)
        assert git_blob(data) == hashes[key]
        (ROOT / name).write_bytes(data)
    metadata = list(csv.DictReader(io.StringIO((ROOT / "esc50.csv").read_text())))
    credits = dict(re.findall(r"^- \[([^\]]+)\.ogg\]: (.+)$", (ROOT / "LICENSE").read_text(encoding="utf-8"), re.M))
    rows = []
    skipped = []
    for row in metadata:
        if row["esc10"].lower() != "true":
            continue
        name = row["filename"]
        assert re.fullmatch(r"[1-5]-[0-9]+-[A-Z]+-[0-9]+\.wav", name)
        original = credits.get(name.rsplit("-", 1)[0], "").strip()
        if not original.endswith(("[CC0]", "[CC-BY]")):
            skipped.append(name)
            continue
        rows.append({**row, "credit": original, "url": BASE + "audio/" + name})

    def download(row):
        name = row["filename"]
        path = ROOT / "wav" / name
        expected = hashes["audio/" + name]
        data = path.read_bytes() if path.exists() else b""
        if git_blob(data) != expected:
            data = fetch(row["url"])
            if git_blob(data) != expected or data[:4] != b"RIFF":
                raise ValueError(f"Invalid source audio: {name}")
            tmp = path.with_suffix(".partial")
            tmp.write_bytes(data)
            tmp.replace(path)
        return {**row, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "git_blob": expected}

    with ThreadPoolExecutor(max_workers=6) as pool:
        files = list(pool.map(download, rows))
    with (ROOT / "manifest.csv").open("w", newline="", encoding="utf-8") as output:
        writer = csv.DictWriter(output, fieldnames=files[0].keys())
        writer.writeheader()
        writer.writerows(files)
    print(f"{len(files)} audio clips verified; {sum(r['bytes'] for r in files):,} bytes. "
          f"Original-clip credit unavailable or outside allowlist: {len(skipped)}.")


if __name__ == "__main__":
    main()
