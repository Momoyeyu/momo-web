// 服务错误：携带「哪个服务 + 怎么挂的」，UI 据此映射成语义化文案
// 而不是把 "404: Not Found" 这类裸信息丢给用户。

type ServiceKind = "llm" | "asr" | "tts";
type ServiceFailure = "unconfigured" | "unreachable" | "http";

export class ServiceError extends Error {
  constructor(
    readonly service: ServiceKind,
    readonly failure: ServiceFailure,
    readonly status = 0,
    detail?: string,
  ) {
    super(detail ?? `${service} ${failure}${status ? ` ${status}` : ""}`);
    this.name = "ServiceError";
  }
}
