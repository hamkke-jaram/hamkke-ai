"""Count person detections in at most three JPEG frames read from stdin."""
import base64
import json
from pathlib import Path
import sys

import cv2
import numpy as np

directory = Path(__file__).resolve().parent
sys.path.insert(0, str(directory))
from yolox import YoloX


def count_people(detector, encoded):
    data = base64.b64decode(encoded, validate=True)
    if len(data) > 300 * 1024:
        raise ValueError("oversize")
    image = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None or max(image.shape[:2]) > 2048:
        raise ValueError("unusable image")
    height, width = image.shape[:2]
    ratio = 640 / max(height, width)
    image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
    resized = cv2.resize(image,(max(1,int(width*ratio)), max(1,int(height*ratio))))
    square = np.full((640,640,3),114,dtype=np.uint8)
    square[:resized.shape[0],:resized.shape[1]] = resized
    objects = detector.infer(square.astype(np.float32))
    return min(80, sum(int(row[5]) == 0 for row in objects))


if __name__ == "__main__":
    frames = json.loads(sys.stdin.buffer.read(3 * 409600 + 64))
    if not isinstance(frames,list) or not 1 <= len(frames) <= 3:
        raise ValueError("frame count")
    cv2.setNumThreads(2)
    model = YoloX(str(directory / 'object_detection_yolox_2022nov.onnx'))
    print(json.dumps([count_people(model,frame) for frame in frames]))
