// Espace Pro : appels à l'API Pixcar (/v1/pro/…), avec le jeton d'accès Cognito. Une erreur de l'API devient une ProApiError qui porte
// son code (« bad_code », « send_limited »…), son message en français et ses détails (attemptsLeft, retryAfter…).
export class ProApiError extends Error {
  constructor(status, error = {}) {
    super(error.message || "Erreur inattendue. Réessayez dans un instant.");
    this.status = status;
    this.code = error.code || (status === 0 ? "network" : "unknown");
    this.details = error;
  }
}

export function createProApi({ base, token, fetchImpl = (...a) => fetch(...a) }) {
  async function call(method, path, body) {
    const access = await token();
    if (!access) throw new ProApiError(401, { code: "unauthorized", message: "Connexion requise." });
    let res;
    try {
      res = await fetchImpl(base + path, {
        method,
        headers: { authorization: `Bearer ${access}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ProApiError(0, { code: "network", message: "Connexion impossible. Vérifiez votre réseau et réessayez." });
    }
    const out = await res.json().catch(() => null);
    if (!res.ok) throw new ProApiError(res.status, (out && out.error) || {});
    return out;
  }
  return {
    me: () => call("GET", "/v1/pro/me"),
    siret: (siret) => call("GET", `/v1/pro/siret/${encodeURIComponent(siret)}`),
    claim: (body) => call("POST", "/v1/pro/claims", body),
    getClaim: (id) => call("GET", `/v1/pro/claims/${encodeURIComponent(id)}`),
    code: (id, code) => call("POST", `/v1/pro/claims/${encodeURIComponent(id)}/code`, { code }),
    resend: (id) => call("POST", `/v1/pro/claims/${encodeURIComponent(id)}/resend`),
  };
}
