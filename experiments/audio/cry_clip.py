"""Experimental 5-second local audio classifier. A probability is not an episode count."""
import argparse
import json
import math
from pathlib import Path

import numpy as np
from scipy.io import wavfile
from scipy.signal import resample_poly

RATE = 16000
WINDOW = 400
HOP = 320
FFT = 512
BANDS = 24


def load_mono(path):
    rate, pcm = wavfile.read(path)
    if pcm.dtype.kind == "i":
        samples = pcm.astype(np.float32) / (-np.iinfo(pcm.dtype).min)
    elif pcm.dtype == np.uint8:
        samples = (pcm.astype(np.float32) - 128) / 128
    elif pcm.dtype.kind == "f":
        samples = pcm.astype(np.float32)
    else:
        raise ValueError(f"Unsupported WAV format {pcm.dtype}")
    if samples.ndim == 2:
        samples = samples.mean(axis=1)
    if not np.isfinite(samples).all() or not 0 < rate <= 384000:
        raise ValueError("Invalid audio samples or rate")
    divisor = math.gcd(RATE, rate)
    return resample_poly(samples, RATE // divisor, rate // divisor).astype("<f4")


def filterbank():
    mel = lambda hz: 2595 * np.log10(1 + hz / 700)
    hz = lambda m: 700 * (10 ** (m / 2595) - 1)
    edges = hz(np.linspace(mel(100), mel(6000), BANDS + 2))
    freq = np.fft.rfftfreq(FFT, 1 / RATE)
    filters = []
    for left, center, right in zip(edges, edges[1:], edges[2:]):
        triangle = np.maximum(0, np.minimum((freq - left) / (center - left), (right - freq) / (right - center)))
        filters.append(triangle / triangle.sum())
    return np.array(filters)


BANK = filterbank()


def features(samples):
    if len(samples) != 5 * RATE:
        raise ValueError("This experimental model expects one five-second audio clip.")
    signal = samples - samples.mean()
    frame = np.lib.stride_tricks.sliding_window_view(signal, WINDOW)[::HOP]
    power = abs(np.fft.rfft(frame * np.hanning(WINDOW), n=FFT)) ** 2
    bands = power @ BANK.T
    # Relative energies remove common recording gain. Cap the influence of silence.
    floor = max(float(bands.max()) * 1e-7, 1e-12)
    logmel = np.log(np.maximum(bands, floor))
    logmel -= logmel.mean(axis=1, keepdims=True)
    return np.concatenate([logmel.mean(axis=0), logmel.std(axis=0),
                           np.abs(np.diff(logmel, axis=0)).mean(axis=0)])


def score(samples, model):
    x = (features(samples) - model["mean"]) / model["scale"]
    z = float(x @ model["weights"] + model["intercept"])
    return 1 / (1 + math.exp(-float(np.clip(z, -60, 60))))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("wav", type=Path)
    args = parser.parse_args()
    model = json.loads(Path(__file__).with_name("cry_model.json").read_text())
    probability = score(load_mono(args.wav), model)
    print(json.dumps({"score": round(probability, 6), "detected": probability >= model["threshold"]}))
