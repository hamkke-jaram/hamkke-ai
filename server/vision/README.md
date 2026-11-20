# 화면에서 따로 보이는 사람 확인

관찰 서버는 최대 세 장의 JPEG를 로컬 CPU 작업자의 표준 입력으로 전달한다. 작업자는 각 프레임의 사람 검출 상자 수만 돌려주고 종료한다. 이미지, 좌표, 얼굴 특징을 저장하지 않는다. 검출 임계치는 OpenCV Zoo 원본의 0.35이다. 사람 검출 실패 또는 가림은 0개로 나올 수 있어 인원수 확정에 단독으로 사용하지 않는다.

Windows 로컬 설치는 이 폴더에서 `uv venv --python 3.12 .venv`, `uv pip install --python .venv/Scripts/python.exe -r requirements.txt`로 구성한다. 다른 인터프리터를 사용하려면 `HAMKKE_PERSON_PYTHON`에 절대 경로를 지정한다. 작업자를 사용할 수 없을 때는 개별 프레임의 시각 모델 검토를 계속한다.

`yolox.py`와 `object_detection_yolox_2022nov.onnx`는 Apache License 2.0으로 공개된 OpenCV Zoo 배포본이다. 모델 SHA-256은 `c5c2d13e59ae883e6af3b45daea64af4833a4951c92d116ec270d9ddbe998063`이다. [원본 배포와 기여자](https://github.com/opencv/opencv_zoo/tree/48b10fa505aeb51fbd127fc60a5c660040e823b7/models/object_detection_yolox) · [라이선스](LICENSE)
