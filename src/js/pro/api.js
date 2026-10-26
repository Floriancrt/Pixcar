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

// onAgreementRequired : appelée quand l'API refuse une écriture faute d'accord de sous-traitance accepté (agreement.js ouvre sa fenêtre)
export function createProApi({ base, token, fetchImpl = (...a) => fetch(...a), onAgreementRequired = () => {} }) {
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
    if (!res.ok) {
      const error = (out && out.error) || {};
      if (res.status === 403 && error.code === "agreement_required") onAgreementRequired();
      throw new ProApiError(res.status, error);
    }
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
    // calendrier avancé (docs/calendrier-avance.md, lot 3a)
    calendar: (id) => call("GET", `${rdv(id)}/calendar`),
    calStart: (id) => call("POST", `${rdv(id)}/calendar/start`),
    calSettings: (id, body) => call("PUT", `${rdv(id)}/calendar/settings`, body),
    saveStaff: (id, staff, body) => call(staff ? "PUT" : "POST", `${rdv(id)}/calendar/staff${staff ? "/" + encodeURIComponent(staff) : ""}`, body),
    deleteStaff: (id, staff) => call("DELETE", `${rdv(id)}/calendar/staff/${encodeURIComponent(staff)}`),
    saveSkill: (id, skill, body) => call(skill ? "PUT" : "POST", `${rdv(id)}/calendar/skills${skill ? "/" + encodeURIComponent(skill) : ""}`, body),
    deleteSkill: (id, skill) => call("DELETE", `${rdv(id)}/calendar/skills/${encodeURIComponent(skill)}`),
    saveResource: (id, res, body) => call(res ? "PUT" : "POST", `${rdv(id)}/calendar/resources${res ? "/" + encodeURIComponent(res) : ""}`, body),
    deleteResource: (id, res) => call("DELETE", `${rdv(id)}/calendar/resources/${encodeURIComponent(res)}`),
    saveReq: (id, service, body) => call("PUT", `${rdv(id)}/calendar/services/${encodeURIComponent(service)}`, body),
    saveUnavail: (id, body) => call("POST", `${rdv(id)}/calendar/unavail`, body),
    deleteUnavail: (id, u) => call("DELETE", `${rdv(id)}/calendar/unavail/${encodeURIComponent(u)}`),
    calCheck: (id, body) => call("POST", `${rdv(id)}/calendar/check`, body || {}),
    calActivate: (id, body) => call("POST", `${rdv(id)}/calendar/activate`, body || {}),
    calSimple: (id) => call("POST", `${rdv(id)}/calendar/simple`),
    // écran Planning (lot 3b)
    calAgenda: (id, from, to) => call("GET", `${rdv(id)}/calendar/agenda?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
    move: (id, request, body) => call("POST", `${rdv(id)}/requests/${encodeURIComponent(request)}/move`, body),
    saveBlock: (id, block, body) => call(block ? "PUT" : "POST", `${rdv(id)}/calendar/blocks${block ? "/" + encodeURIComponent(block) : ""}`, body),
    deleteBlock: (id, block) => call("DELETE", `${rdv(id)}/calendar/blocks/${encodeURIComponent(block)}`),
    // lot 3c : état d'une intervention, raccourcis du tableau de bord
    work: (id, ref, body) => call("POST", `${rdv(id)}/calendar/work/${encodeURIComponent(ref)}`, body),
    putPrefs: (id, body) => call("PUT", `/v1/pro/garages/${encodeURIComponent(id)}/prefs`, body),
    // accord de sous-traitance des données (docs/sous-traitance.md)
    agreement: (id) => call("GET", `/v1/pro/garages/${encodeURIComponent(id)}/agreement`),
    acceptAgreement: (id, version) => call("POST", `/v1/pro/garages/${encodeURIComponent(id)}/agreement`, { version, accept: true }),
  };
}
