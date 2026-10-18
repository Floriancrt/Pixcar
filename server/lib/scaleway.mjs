// Envoi d'e-mails par Scaleway Transactional Email (TEM), Paris : utilisé à la place d'Amazon SES, dont le compte reste en mode test.
//   POST https://api.scaleway.com/transactional-email/v1alpha1/regions/<région>/emails, en-tête X-Auth-Token = clé secrète d'une application
//   IAM limitée à l'envoi (permission TransactionalEmailEmailApiCreate sur le projet). Le domaine d'expédition doit être vérifié chez Scaleway.
// La clé secrète ne figure jamais dans une erreur ni dans un journal. Sans dépendance : fetch de Node.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isScwProjectId = (v) => UUID_RE.test(String(v || ""));

// « Pixcar <verification@pixcar.fr> » → { name: "Pixcar", email: "verification@pixcar.fr" } ; une adresse seule → { email }
export function parseAddress(raw) {
  const s = String(raw || "").trim();
  const m = /^(.*?)\s*<([^<>\s]+@[^<>\s]+)>$/.exec(s);
  if (m) return m[1] ? { name: m[1].replace(/^"|"$/g, ""), email: m[2] } : { email: m[2] };
  if (/^[^\s@<>]+@[^\s@<>]+$/.test(s)) return { email: s };
  throw new Error("adresse d'expédition illisible");
}

export class ScalewayError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ScalewayError";
    this.status = status;
  }
}

export function createScalewayMailer({ secretKey, projectId, region = "fr-par", fetchImpl = (...a) => fetch(...a), timeoutMs = 8000 }) {
  if (!secretKey) throw new Error("Scaleway : clé secrète absente (SCW_SECRET_KEY)");
  if (!isScwProjectId(projectId)) throw new Error("Scaleway : identifiant de projet invalide (UUID attendu)");
  if (!/^[a-z]{2}-[a-z]{3}$/.test(region)) throw new Error("Scaleway : région invalide");
  const url = `https://api.scaleway.com/transactional-email/v1alpha1/regions/${region}/emails`;
  return {
    // { from: "Nom <adresse>", to: "adresse", subject, text, html?, replyTo?, attachments?: [{ name, type, content (texte) }] } → { id } ;
    // lève ScalewayError (statut HTTP) si Scaleway refuse. Reply-To passe par additional_headers ; une pièce jointe, en base64 (2 Mo au plus).
    async send({ from, to, subject, text, html, replyTo, attachments }) {
      const body = { project_id: projectId, from: parseAddress(from), to: [{ email: String(to) }], subject, text };
      if (html) body.html = html;
      if (replyTo) body.additional_headers = [{ key: "Reply-To", value: String(replyTo) }];
      if (attachments && attachments.length) body.attachments = attachments.map((a) => ({ name: a.name, type: a.type, content: Buffer.from(a.content, "utf8").toString("base64") }));
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let res;
      try {
        res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", "x-auth-token": secretKey }, body: JSON.stringify(body), signal: ctrl.signal });
      } catch (e) {
        throw new ScalewayError(`Scaleway injoignable (${e && e.name === "AbortError" ? "délai dépassé" : "réseau"})`, 0);
      } finally {
        clearTimeout(timer);
      }
      let out = null;
      try {
        out = await res.json();
      } catch {
        out = null;
      }
      if (!res.ok) {
        // message de Scaleway (jamais la requête : elle contient l'adresse du destinataire), tronqué
        const why = String((out && (out.message || out.type)) || "").slice(0, 200);
        throw new ScalewayError(`Scaleway a refusé l'envoi (HTTP ${res.status}${why ? " : " + why : ""})`, res.status);
      }
      const first = out && Array.isArray(out.emails) ? out.emails[0] : null;
      return { id: (first && (first.id || first.message_id)) || "" };
    },
  };
}
