// 서버 지표(GET /ai/v1/metrics, Prometheus 글 형식 0.0.4).
// 담는 것: 경로·상태·결과 코드별 요청 수, 걸린 시간 분포, 모델 호출 결과, 대기열 길이, 모델 준비 상태.
// 담지 않는 것: 사진, 관찰 문장, 토큰, jti, 요청 id, 아이·사용자 식별 값. 라벨 값은 정해 둔 목록(경로·코드)과 모델 이름뿐이다.

export type MetricsRoute = 'analyze' | 'health' | 'metrics' | 'other';
export type ModelCallResult = 'ok' | 'bad_output' | 'unavailable' | 'timeout' | 'aborted';

/** 걸린 시간 구간(초). 건강 확인(수 밀리초)부터 모델 제한 시간(180초)까지 본다. */
export const LATENCY_BUCKETS_SEC = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 30, 60, 90, 120, 180, 300] as const;

export interface MetricsGauges {
  queueActive: number;
  queueWaiting: number;
  maxConcurrency: number;
  maxWaiting: number;
  modelReady: boolean;
  jtiStored: number;
}

export interface MetricsInfo {
  model: string;
  fallbackModel: string | null;
  promptVersion: string;
}

export interface Metrics {
  recordRequest(route: MetricsRoute, status: number, code: string, ms: number): void;
  recordModelCall(result: ModelCallResult): void;
  /** 관찰 기록을 만든 모델(영수증 mv). 대신 쓰는 모델이면 fallback 이 true. */
  recordObservation(model: string, fallback: boolean): void;
  render(gauges: MetricsGauges, info: MetricsInfo): string;
}

interface Histogram {
  buckets: number[];
  sum: number;
  count: number;
}

/** 라벨 값 이스케이프(백슬래시, 큰따옴표, 줄바꿈). */
export function labelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** 코드·경로처럼 정해 둔 값만 라벨에 들어가게 한다. 모르는 모양이면 'other'. */
function safeToken(value: string): string {
  return /^[A-Za-z0-9_]{1,40}$/.test(value) ? value : 'other';
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(Math.round(value * 1e6) / 1e6);
}

export function createMetrics(startedAtMs: number = Date.now()): Metrics {
  const requests = new Map<string, number>(); // "route|status|code" → 수
  const latency = new Map<MetricsRoute, Histogram>();
  const modelCalls = new Map<ModelCallResult, number>();
  const observations = new Map<string, number>(); // "model|fallback" → 수

  function bump<K>(map: Map<K, number>, key: K): void {
    map.set(key, (map.get(key) ?? 0) + 1);
  }

  function recordRequest(route: MetricsRoute, status: number, code: string, ms: number): void {
    bump(requests, `${route}|${Math.trunc(status)}|${safeToken(code)}`);
    let histogram = latency.get(route);
    if (!histogram) {
      histogram = { buckets: LATENCY_BUCKETS_SEC.map(() => 0), sum: 0, count: 0 };
      latency.set(route, histogram);
    }
    const seconds = Math.max(0, ms) / 1000;
    LATENCY_BUCKETS_SEC.forEach((le, i) => {
      if (seconds <= le) histogram.buckets[i]!++;
    });
    histogram.sum += seconds;
    histogram.count++;
  }

  function recordModelCall(result: ModelCallResult): void {
    bump(modelCalls, result);
  }

  function recordObservation(model: string, fallback: boolean): void {
    bump(observations, `${model}|${fallback ? 'true' : 'false'}`);
  }

  function render(gauges: MetricsGauges, info: MetricsInfo): string {
    const lines: string[] = [];
    const head = (name: string, type: 'counter' | 'gauge' | 'histogram', help: string): void => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    };

    head('hamkke_ai_info', 'gauge', 'Model and prompt version served by this AI server.');
    const fallback = info.fallbackModel === null ? '' : `,fallback_model="${labelValue(info.fallbackModel)}"`;
    lines.push(`hamkke_ai_info{model="${labelValue(info.model)}"${fallback},prompt_version="${labelValue(info.promptVersion)}"} 1`);

    head('hamkke_ai_start_time_seconds', 'gauge', 'Unix time when the server started.');
    lines.push(`hamkke_ai_start_time_seconds ${Math.floor(startedAtMs / 1000)}`);

    head('hamkke_ai_requests_total', 'counter', 'Requests by route, HTTP status and result code.');
    for (const [key, count] of [...requests].sort(([a], [b]) => a.localeCompare(b))) {
      const [route, status, code] = key.split('|') as [string, string, string];
      lines.push(`hamkke_ai_requests_total{route="${route}",status="${status}",code="${code}"} ${count}`);
    }

    head('hamkke_ai_request_duration_seconds', 'histogram', 'Request handling time in seconds.');
    for (const [route, histogram] of [...latency].sort(([a], [b]) => a.localeCompare(b))) {
      LATENCY_BUCKETS_SEC.forEach((le, i) => {
        lines.push(`hamkke_ai_request_duration_seconds_bucket{route="${route}",le="${le}"} ${histogram.buckets[i]}`);
      });
      lines.push(`hamkke_ai_request_duration_seconds_bucket{route="${route}",le="+Inf"} ${histogram.count}`);
      lines.push(`hamkke_ai_request_duration_seconds_sum{route="${route}"} ${formatNumber(histogram.sum)}`);
      lines.push(`hamkke_ai_request_duration_seconds_count{route="${route}"} ${histogram.count}`);
    }

    head('hamkke_ai_model_calls_total', 'counter', 'Model calls by result (one request can call the model twice).');
    for (const [result, count] of [...modelCalls].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`hamkke_ai_model_calls_total{result="${result}"} ${count}`);
    }

    head('hamkke_ai_observations_total', 'counter', 'Observations returned, by the model that wrote them.');
    for (const [key, count] of [...observations].sort(([a], [b]) => a.localeCompare(b))) {
      const split = key.lastIndexOf('|');
      lines.push(
        `hamkke_ai_observations_total{model="${labelValue(key.slice(0, split))}",fallback="${key.slice(split + 1)}"} ${count}`,
      );
    }

    head('hamkke_ai_queue_active', 'gauge', 'Requests calling the model right now.');
    lines.push(`hamkke_ai_queue_active ${gauges.queueActive}`);
    head('hamkke_ai_queue_waiting', 'gauge', 'Requests waiting for a model slot.');
    lines.push(`hamkke_ai_queue_waiting ${gauges.queueWaiting}`);
    head('hamkke_ai_queue_max_concurrency', 'gauge', 'VL_MAX_CONCURRENCY.');
    lines.push(`hamkke_ai_queue_max_concurrency ${gauges.maxConcurrency}`);
    head('hamkke_ai_queue_max_waiting', 'gauge', 'VL_MAX_WAITING.');
    lines.push(`hamkke_ai_queue_max_waiting ${gauges.maxWaiting}`);
    head('hamkke_ai_model_ready', 'gauge', '1 when the model (or the fallback model) can be used.');
    lines.push(`hamkke_ai_model_ready ${gauges.modelReady ? 1 : 0}`);
    head('hamkke_ai_used_sessions', 'gauge', 'Analysis session ids remembered until they expire.');
    lines.push(`hamkke_ai_used_sessions ${gauges.jtiStored}`);

    return `${lines.join('\n')}\n`;
  }

  return { recordRequest, recordModelCall, recordObservation, render };
}
