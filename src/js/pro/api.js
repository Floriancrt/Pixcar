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

const rdv = (id) => `/v1/pro/garages/${encodeURIComponent(id)}/rdv`;

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
    garage: (id) => call("GET", `/v1/pro/garages/${encodeURIComponent(id)}`),
    putPrice: (id, service, body) => call("PUT", `/v1/pro/garages/${encodeURIComponent(id)}/prices/${encodeURIComponent(service)}`, body),
    deletePrice: (id, service) => call("DELETE", `/v1/pro/garages/${encodeURIComponent(id)}/prices/${encodeURIComponent(service)}`),
    confirm: (id) => call("POST", `/v1/pro/garages/${encodeURIComponent(id)}/confirm`),
    // « Mon garage »
    profile: (id) => call("GET", `/v1/pro/garages/${encodeURIComponent(id)}/profile`),
    putProfile: (id, body) => call("PUT", `/v1/pro/garages/${encodeURIComponent(id)}/profile`, body),
    requestChange: (id, body) => call("POST", `/v1/pro/garages/${encodeURIComponent(id)}/changes`, body),
    cancelChange: (id, change) => call("DELETE", `/v1/pro/garages/${encodeURIComponent(id)}/changes/${encodeURIComponent(change)}`),
    putService: (id, service, body) => call("PUT", `/v1/pro/garages/${encodeURIComponent(id)}/services/${encodeURIComponent(service)}`, body),
    registry: (id) => call("GET", `/v1/pro/garages/${encodeURIComponent(id)}/registry`),
    // rendez-vous en ligne (docs/rendez-vous.md, lot 2)
    agenda: (id) => call("GET", `${rdv(id)}`),
    rdvSettings: (id, body) => call("PUT", `${rdv(id)}/settings`, body),
    saveSlot: (id, slot, body) => call(slot ? "PUT" : "POST", `${rdv(id)}/slots${slot ? "/" + encodeURIComponent(slot) : ""}`, body),
    deleteSlot: (id, slot) => call("DELETE", `${rdv(id)}/slots/${encodeURIComponent(slot)}`),
    saveClosure: (id, closure, body) => call(closure ? "PUT" : "POST", `${rdv(id)}/closures${closure ? "/" + encodeURIComponent(closure) : ""}`, body),
    deleteClosure: (id, closure) => call("DELETE", `${rdv(id)}/closures/${encodeURIComponent(closure)}`),
    notify: (id, email) => call("POST", `${rdv(id)}/notify`, { email }),
    notifyCode: (id, code) => call("POST", `${rdv(id)}/notify/code`, { code }),
    requests: (id, view) => call("GET", `${rdv(id)}/requests?view=${encodeURIComponent(view)}`),
    decide: (id, request, act, body) => call("POST", `${rdv(id)}/requests/${encodeURIComponent(request)}/${act}`, body || {}),
  };
}
