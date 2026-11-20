"""Verify archived input bytes, PEFT checkpoints and scores without loading either model."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def read_json(name):
    return json.loads((ROOT / name).read_text(encoding="utf-8-sig"))


def read_locked_rows(name, digest):
    data = (ROOT / name).read_bytes()
    assert hashlib.sha256(data).hexdigest() == digest, name
    return [json.loads(line) for line in data.decode("utf-8-sig").splitlines()]


def check_scores(rows, predictions, baseline, tuned):
    assert len(rows) == len(predictions) == baseline["n"] == tuned["n"]
    for row, prediction in zip(rows, predictions):
        assert row == {key: prediction[key] for key in row}, row["group"]
    for key, expected in [("baseKeep", baseline), ("adapterKeep", tuned)]:
        assert sum(row["keep"] == pred[key] for row, pred in zip(rows, predictions)) == expected["correct"]


def main():
    lock = read_json("data-lock.json")
    small = read_json("result.json")
    large = read_json("four-b/result.json")
    assert lock == small["dataLock"]
    captions = read_locked_rows("public-data/train-source.jsonl", lock["sourceSha256"])
    assert len(captions) == len({row["imageId"] for row in captions}) == lock["publicSourceCount"]
    manifest = read_json("public-data/manifest.json")
    assert manifest["outputSha256"] == lock["sourceSha256"]
    assert manifest["sampleSize"] == len(captions)

    train = read_locked_rows("train.jsonl", lock["trainSha256"])
    held = read_locked_rows("heldout.jsonl", lock["heldoutSha256"])
    independent_result = read_json("independent-result.json")
    independent = read_locked_rows("public-data/independent-test.jsonl", independent_result["sourceSha256"])
    assert large["trainDataSha256"] == lock["trainSha256"]
    assert large["independentDataSha256"] == independent_result["sourceSha256"]
    assert len(train) == lock["train"] and len(held) == lock["heldout"]
    assert {row["evidence"] for row in train}.isdisjoint(row["evidence"] for row in held + independent)

    for adapter, result in [("adapter", small), ("four-b/adapter", large)]:
        weights = (ROOT / adapter / "adapter_model.safetensors").read_bytes()
        assert hashlib.sha256(weights).hexdigest() == result["adapterSha256"], adapter
        config = read_json(Path(adapter) / "adapter_config.json")
        assert config["base_model_name_or_path"] == result["model"] and config["revision"] == result["revision"]
        assert (ROOT / adapter / "BASE_MODEL_LICENSE.txt").is_file()
        print(f"{result['model']}: {len(weights):,} bytes, SHA-256 {result['adapterSha256']}")

    check_scores(held, read_json("heldout-predictions.json"), small["baselineHeldout"], small["adapterHeldout"])
    scores = read_json("four-b/predictions.json")
    for name, rows, predictions in [("heldout", held, scores[:len(held)]), ("independent", independent, scores[len(held):])]:
        check_scores(rows, predictions, large[name]["base"], large[name]["adapter"])
    audit = read_json("reload-audit.json")
    assert audit["independent"]["baseline"] == independent_result["baseline"]
    assert audit["independent"]["adapter"] == independent_result["adapter"]
    print(f"Verified {len(captions)} COCO captions, {len(train)} training, {len(held)} held-out and {len(independent)} independent claims.")


if __name__ == "__main__":
    main()
