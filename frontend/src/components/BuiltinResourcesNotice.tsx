// Built-in recall needs attention only when its resources or index are unavailable.
import { useEffect, useState } from "react";
import { apiJson } from "../services/http";
import { useT } from "../i18n";

interface ResourceStatus {
  embedding: { state: string };
  index: { state: string };
}

export default function BuiltinResourcesNotice() {
  const t = useT();
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void apiJson<ResourceStatus>("/api/resources/status", {signal: controller.signal})
      .then(status => {
        if (!controller.signal.aborted && status?.embedding && status.index) {
          setUnavailable(["missing", "error"].includes(status.embedding.state) || status.index.state === "degraded");
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);
  return unavailable ? <div className="builtin-resource-notice" role="status">
    <p>{t("settings.builtinRecallUnavailable")}</p>
  </div> : null;
}
