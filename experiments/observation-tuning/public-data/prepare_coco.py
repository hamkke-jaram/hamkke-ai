"""Fetch only the CC BY 4.0 training captions, then reproduce this Korean action subset."""
import argparse
import hashlib
import io
import json
import re
import tempfile
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
URL = "https://s3.amazonaws.com/images.cocodataset.org/annotations/annotations_trainval2017.zip"
MEMBER = "annotations/captions_train2017.json"
ETAG = '"f4bbac642086de4f52a3fdda2de5fa2c"'
MEMBER_SHA = '4b62086319480e0739ef390d04084515defb9c213ff13605a036061e33314317'
cache = Path(tempfile.gettempdir()) / "hamkke-coco-captions-train2017.json"


class ArchiveRanges(io.RawIOBase):
    def __init__(self):
        with urllib.request.urlopen(urllib.request.Request(URL, method="HEAD"), timeout=30) as r:
            assert r.headers["ETag"] == ETAG
            self.length = int(r.headers["Content-Length"])
        self.pos = 0

    def tell(self):
        return self.pos

    def seekable(self):
        return True

    def seek(self, offset, whence=0):
        self.pos = offset + (0, self.pos, self.length)[whence]
        if self.pos < 0:
            raise OSError("negative seek")
        return self.pos

    def read(self, size=-1):
        size = min(self.length-self.pos, self.length if size < 0 else size)
        if size <= 0:
            return b""
        req = urllib.request.Request(URL, headers={"Range":f"bytes={self.pos}-{self.pos+size-1}", "If-Match":ETAG})
        with urllib.request.urlopen(req, timeout=90) as r:
            assert r.status == 206 and r.headers["ETag"] == ETAG
            data = r.read()
        assert len(data) == size
        self.pos += size
        return data


def read_source():
    if not cache.exists():
        with zipfile.ZipFile(ArchiveRanges()) as archive:
            payload = archive.read(MEMBER)  # ZIP verifies the whole member CRC32.
        cache.write_bytes(payload)
    content = cache.read_bytes()
    source_sha = hashlib.sha256(content).hexdigest()
    assert source_sha == MEMBER_SHA
    return json.loads(content)["annotations"], source_sha


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--list", action="store_true", help="List candidate English source captions.")
    opts = parser.parse_args()
    anns, sha = read_source()
    if opts.list:
        # Retrieve candidates for manual curation. The retained translation table is fixed.
        groups = {
            "gaze": r"\b(looks? at|looking at|watches|watching)\b",
            "point": r"\b(points? (at|to)|pointing (at|to)|reaching (out |up )?(for|to))\b",
            "hand": r"\b(holding|holds|grasping|grabs)\b",
            "objects": r"\b(cutting|pouring|brushing|drawing|reading|writing|peeling|stirring)\b",
            "movement": r"\b(kneeling|squatting|bending|jumping|walking|sitting|standing)\b",
            "solo": r"\b(alone|by himself|by herself|by themselves)\b",
            "nonplay": r"\b(together|side by side|next to each other)\b",
            "jointplay": r"\b(playing|play)\b",
        }
        used = set()
        for name, expr in groups.items():
            count = 0
            print("#", name)
            for row in anns:
                caption = row["caption"].strip()
                if row["image_id"] in used or len(caption) > 105 or not re.search(expr,caption,re.I):
                    continue
                if not re.search(r"\b(boys?|girls?|child(?:ren)?|kids?|people|person|woman|man|men|women|players?)\b",caption,re.I):
                    continue
                if name == "jointplay" and not re.search(r"\b(two|pair|group|team|several|boys|girls|men|women|kids|children|people)\b",caption,re.I):
                    continue
                used.add(row["image_id"])
                print(row["id"], row["image_id"], caption)
                count += 1
                if count == 14:
                    break
        print("source SHA256",sha)
        return
    translations = (ROOT/"translations.tsv").read_text("utf-8").splitlines()
    refs = {row["id"]:row for row in anns}
    records = []
    for line in translations:
        cid, subject, action = line.split("\t")
        row = refs[int(cid)]
        assert action.endswith(".") and subject in {"child","person","multiple"}
        records.append({"sourceId":f"coco-2017-train-caption-{cid}","imageId":row["image_id"],
                        "subjectKey":subject,"action":action,"sourceCaption":row["caption"].strip(),
                        "license":"CC-BY-4.0","credit":"COCO Consortium"})
    assert len(records) == len({row["imageId"] for row in records}) == len({row["action"] for row in records})
    result = "".join(json.dumps(rec, ensure_ascii=False)+"\n" for rec in records).encode()
    (ROOT/"train-source.jsonl").write_bytes(result)
    manifest = {"dataset":"COCO Captions 2017 train","url":URL,"archiveEtag":ETAG, "member":MEMBER,
                "memberSha256":sha, "sourceCaptionCount":len(anns),"sampleSize":len(records),
                "outputSha256":hashlib.sha256(result).hexdigest(),"terms":"https://cocodataset.org/dataset/termsofuse.htm",
                "license":"https://creativecommons.org/licenses/by/4.0/","attribution":"COCO Consortium",
                "changes":"Selected annotations, translated to Korean, retained visible actions and generalized unneeded person attributes. No images were downloaded."}
    (ROOT/"manifest.json").write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+"\n","utf-8")
    print(json.dumps(manifest,ensure_ascii=False))


if __name__ == "__main__":
    main()
