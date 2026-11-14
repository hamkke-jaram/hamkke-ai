# 함께자람 AI 서버 (AI 관찰 기록).
# 빌드 문맥은 저장소 루트다:  docker build -f server/Dockerfile -t hamkke-ai .
FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=8090

WORKDIR /app

# 실행에 필요한 것은 Node 와 server/src 뿐이다(npm 의존성 없음, 타입은 실행할 때 지워진다).
# package.json 은 "type": "module" 을 알려 주려고 함께 넣는다.
COPY package.json ./
COPY server/src ./server/src

# 사진을 디스크에 쓰지 않는 서버다. 쓰기 권한이 없는 사용자로 돌린다.
USER node

EXPOSE 8090

# 건강 확인은 '서버가 살아 있는지'만 본다(언제나 200). 모델이 준비되지 않았다고 컨테이너를 다시 켜도 나아지지 않기 때문이다.
# 모델 준비 여부는 바깥 가동 감시에서 /ai/v1/health?strict=1(준비 안 됨 → 503)이나 /ai/v1/metrics 로 따로 본다.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/ai/v1/health" || exit 1

CMD ["node", "server/src/index.ts"]
