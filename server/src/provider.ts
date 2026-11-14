// 모델 제공자 인터페이스. v1 구현은 Ollama(ollama.ts)이고, 다른 제공자는 이 인터페이스만 맞추면 된다.

export interface VisionRequest {
  /** 규칙과 태그 목록을 담은 지시문. */
  system: string;
  /** 사진 장수와 각 사진의 시각을 알려 주는 요청문. */
  user: string;
  /** JPEG base64 문자열. 시각 순서. 제공자는 이 값을 저장하거나 로그에 남기면 안 된다. */
  images: readonly string[];
  /** 출력이 따라야 하는 JSON 스키마. */
  schema: Record<string, unknown>;
  /** 제한 시간이 지나거나 요청한 쪽이 끊으면 중단된다. 제공자는 이 신호를 따라야 한다. */
  signal: AbortSignal;
}

/** 모델이 쓴 글과, 그 글을 실제로 쓴 모델 이름(대신 쓰는 모델로 바뀌었을 때). */
export interface VisionOutput {
  text: string;
  modelVersion: string;
}

export interface VisionProvider {
  /** 기본 모델 이름. 글만 돌려준 호출의 영수증 mv 와 응답의 modelVersion 으로 나간다. */
  readonly modelVersion: string;
  /**
   * 모델이 쓴 글(JSON 이어야 함)을 그대로 돌려준다. 해석과 검사는 서버가 한다.
   * 다른 모델이 대신 썼으면 { text, modelVersion } 으로 그 모델 이름을 함께 돌려준다(영수증 mv 에 들어간다).
   */
  generate(request: VisionRequest): Promise<string | VisionOutput>;
  /** 모델을 바로 쓸 수 있는지. 사진이나 문장을 보내지 않는 가벼운 확인이어야 한다. */
  isReady(signal: AbortSignal): Promise<boolean>;
  /** (선택) 모델을 미리 메모리에 올린다. 사진이나 문장을 보내지 않는다. 실패하면 ProviderUnavailableError. */
  warmUp?(signal: AbortSignal): Promise<void>;
  /** (선택) 대신 쓰는 모델 이름. 건강 확인과 지표에 보인다. */
  readonly fallbackModelVersion?: string;
}

/** 모델 서버에 닿지 못했거나 쓸 수 없는 응답을 받았을 때. detail 은 로그용 짧은 코드다. */
export class ProviderUnavailableError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super('model provider unavailable');
    this.name = 'ProviderUnavailableError';
    this.detail = detail;
  }
}

/** 제공자가 스스로 정한 제한 시간을 넘겼을 때(서버의 제한 시간과 별개). */
export class ProviderTimeoutError extends Error {
  constructor() {
    super('model provider timed out');
    this.name = 'ProviderTimeoutError';
  }
}

/** generate 결과를 { text, modelVersion } 으로 맞춘다. */
export function toVisionOutput(result: string | VisionOutput, fallbackVersion: string): VisionOutput {
  return typeof result === 'string' ? { text: result, modelVersion: fallbackVersion } : result;
}
