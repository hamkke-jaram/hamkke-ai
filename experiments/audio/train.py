# /// script
# requires-python = ">=3.11,<3.14"
# dependencies = ["numpy==2.2.6", "scipy==1.15.3", "scikit-learn==1.6.1"]
# ///
"""uv run train.py; development folds 1-3, threshold fold 4, untouched test fold 5."""
import base64
import csv
import hashlib
import json
from pathlib import Path
import subprocess

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

from cry_clip import features, load_mono, score

HERE = Path(__file__).resolve().parent
DATA = HERE / "esc10"


def metrics(y, predictions):
    y, p = np.asarray(y, bool), np.asarray(predictions, bool)
    tp, tn = int((y & p).sum()), int((~y & ~p).sum())
    fp, fn = int((~y & p).sum()), int((y & ~p).sum())
    return dict(n=len(y), tp=tp, tn=tn, fp=fp, fn=fn,
                precision=tp / max(1, tp + fp), recall=tp / max(1, tp + fn),
                f1=2 * tp / max(1, 2 * tp + fp + fn))


def main():
    with (DATA / "manifest.csv").open(encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    folds = np.array([int(r["fold"]) for r in rows])
    source_groups = [{r["src_file"] for r in rows if int(r["fold"]) == fold} for fold in range(1, 6)]
    assert sum(map(len, source_groups)) == len(set.union(*source_groups)), "Source recording crosses folds"
    y = np.array([r["category"] == "crying_baby" for r in rows])
    X, old = [], {}
    for start in range(0, len(rows), 10):
        batch = []
        for r in rows[start:start + 10]:
            path = DATA / "wav" / r["filename"]
            assert hashlib.sha256(path.read_bytes()).hexdigest() == r["sha256"]
            pcm = load_mono(path)
            X.append(features(pcm))
            batch.append(dict(name=r["filename"], pcm=base64.b64encode(pcm.tobytes()).decode("ascii")))
        proc = subprocess.run(["node", str(HERE / "score_existing.mjs")], input=json.dumps(batch),
                              text=True, capture_output=True, check=True)
        for line in proc.stdout.splitlines():
            record = json.loads(line)
            old[record["name"]] = record["detected"]
    X = np.array(X)
    train, dev, test = folds <= 3, folds == 4, folds == 5
    scaler = StandardScaler().fit(X[train])
    classifier = LogisticRegression(C=1, class_weight="balanced", random_state=0, max_iter=1000)
    classifier.fit(scaler.transform(X[train]), y[train])
    prob_dev = classifier.predict_proba(scaler.transform(X[dev]))[:, 1]
    # Fixed grid and tie-break before accessing test decisions.
    threshold = max(np.arange(0.10, 0.901, 0.05),
                    key=lambda t: (metrics(y[dev], prob_dev >= t)["f1"], -abs(t - 0.5)))
    model = dict(task="crying_baby sound present in 5 seconds", revision="esc10-clip-v1",
                 mean=scaler.mean_.tolist(), scale=scaler.scale_.tolist(),
                 weights=classifier.coef_[0].tolist(), intercept=float(classifier.intercept_[0]),
                 threshold=float(threshold))
    (HERE / "cry_model.json").write_text(json.dumps(model, indent=2) + "\n", encoding="utf-8")
    all_prob = classifier.predict_proba(scaler.transform(X))[:, 1]
    baseline = np.array([old[r["filename"]] for r in rows])
    report = dict(fit_samples=int(train.sum()), threshold_samples=int(dev.sum()), test_samples=int(test.sum()),
                  threshold=float(threshold), fold5_sources=len(source_groups[4]), development={},
                  heldout={}, negative_classes_heldout={})
    for name, mask in [("development", dev), ("heldout", test)]:
        report[name] = dict(existing=metrics(y[mask], baseline[mask]),
                            candidate=metrics(y[mask], all_prob[mask] >= threshold))
    for idx in np.where(test)[0]:
        r = rows[idx]
        deployed_score = score(load_mono(DATA / "wav" / r["filename"]), model)
        assert abs(deployed_score - all_prob[idx]) < 1e-5
    for category in sorted({r["category"] for r in rows} - {"crying_baby"}):
        mask = test & np.array([r["category"] == category for r in rows])
        report["negative_classes_heldout"][category] = dict(n=int(mask.sum()), existing_fp=int(baseline[mask].sum()),
                                                          candidate_fp=int((all_prob[mask] >= threshold).sum()))
    with (HERE / "predictions.csv").open("w", newline="") as f:
        wr = csv.writer(f)
        wr.writerow(["filename","fold","expected","existing","candidate","score"])
        for i,r in enumerate(rows):
            wr.writerow([r["filename"],folds[i],int(y[i]),int(baseline[i]),int(all_prob[i]>=threshold),round(all_prob[i],6)])
    (HERE / "results.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report["heldout"], indent=2))


if __name__ == "__main__":
    main()
