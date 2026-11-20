"""Recheck the pinned official downloads and their UTF-8 extracts (lxml, pypdf)."""

import hashlib
import io
import json
import re
from pathlib import Path
from urllib.request import Request, urlopen

from lxml import html
from pypdf import PdfReader


ROOT = Path(__file__).resolve().parent


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_gazette(data):
    pages = []
    for number, page in enumerate(PdfReader(io.BytesIO(data)).pages, start=1):
        lines = [re.sub(r"[ \t\0]+", " ", line).strip()
                 for line in (page.extract_text() or "").splitlines()]
        pages.append(f"[PDF {number}쪽]\n" + "\n".join(lines) + "\n")
    return "\n".join(pages).encode("utf-8")


def read_article(data):
    doc = html.fromstring(data.decode("utf-8"))
    terms = " ".join(doc.xpath('//div[@class="kogl"]//text()'))
    if "공공누리 제1유형" not in terms:
        raise ValueError("Recheck the current licence before using this article.")
    article, = doc.xpath('//div[@class="view_cont"]')
    lines = []
    for para in article.xpath(".//p"):
        fragments = para.xpath(".//text()[not(ancestor::script) and not(ancestor::style)]")
        line = re.sub(r"\s+", " ", " ".join(fragments)).strip()
        if line:
            lines.append(line)
    return ("\n".join(lines) + "\n").encode("utf-8")


def main():
    for source in json.loads((ROOT / "sources.json").read_text(encoding="utf-8")):
        key = source["sourceKey"]
        snapshot = (ROOT / source["asset"]).read_bytes()
        if digest(snapshot) != source["sha256"]:
            raise ValueError(f"Stored text changed: {key}")
        request = Request(source["downloadUrl"], headers={"User-Agent": "HamkkeJaram-Evidence-Verification/1.0"})
        with urlopen(request, timeout=35) as response:
            data = response.read()
        if "originalSha256" in source and digest(data) != source["originalSha256"]:
            raise ValueError(f"Official PDF changed: {key}")
        if "originalAsset" in source and data != (ROOT / source["originalAsset"]).read_bytes():
            raise ValueError(f"Archived PDF changed: {key}")
        if key == "MOE-CARE-2024":
            extracted = read_gazette(data)
        elif key == "MOHW-ROUTINES-2024":
            extracted = read_article(data)
        elif key == "MOHW-POSITIVE-129":
            # The text is embedded in a picture on page 3. Two lines were manually
            # transcribed from the pinned original; the file and transcription are both hashed.
            extracted = snapshot
        else:
            raise ValueError(f"No source-specific check for {key}")
        if extracted != snapshot:
            raise ValueError(f"Re-review changed official text: {key}")
        print(f"{key}: verified")


if __name__ == "__main__":
    main()
