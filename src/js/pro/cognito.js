// Espace Pro : connexion SANS MOT DE PASSE au groupe d'utilisateurs Amazon Cognito, par l'API publique de Cognito (aucune bibliothèque) :
//  - connexion : InitiateAuth (USER_AUTH, défi préféré EMAIL_OTP) → code reçu par e-mail (8 chiffres ; 6 pour la confirmation d'inscription) → RespondToAuthChallenge ;
//  - inscription : SignUp (e-mail seul) → code reçu → ConfirmSignUp → connexion immédiate avec la session rendue par ConfirmSignUp ;
//  - jetons : jeton d'accès (1 h) envoyé à l'API Pixcar, renouvelé avec le jeton de rafraîchissement ; déconnexion : RevokeToken.
// Les jetons restent dans sessionStorage (fermer l'onglet déconnecte) ; jamais dans un cookie ni dans localStorage.
const KEY = "pixcar-pro-session";

export class CognitoError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Message en français pour une erreur de Cognito (le code vient de « __type »).
export function explain(e) {
  const code = (e && e.code) || "";
  if (code === "UserNotFoundException") return "Aucun accès pour cette adresse. Créez-le avec « Gérer mon garage ».";
  if (code === "UsernameExistsException") return "Un accès existe déjà pour cette adresse : connectez-vous.";
  if (code === "CodeMismatchException") return "Code incorrect. Vérifiez le dernier e-mail reçu.";
  if (code === "ExpiredCodeException") return "Ce code a expiré. Demandez-en un nouveau.";
  if (code === "NotAuthorizedException") return "La session a expiré. Recommencez la connexion.";
  if (code === "LimitExceededException" || code === "TooManyRequestsException" || code === "TooManyFailedAttemptsException") return "Trop d'essais. Patientez quelques minutes.";
  if (code === "InvalidParameterException") return "Adresse e-mail invalide.";
  if (code === "network") return "Connexion impossible. Vérifiez votre réseau et réessayez.";
  return "La connexion a échoué. Réessayez dans un instant.";
}

export function createCognito({ userPoolId, clientId, fetchImpl = (...a) => fetch(...a), storage = safeStorage(), now = Date.now }) {
  const region = String(userPoolId).split("_")[0];
  const endpoint = `https://cognito-idp.${region}.amazonaws.com/`;

  async function call(action, body) {
    let res;
    try {
      res = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": `AWSCognitoIdentityProviderService.${action}` },
        body: JSON.stringify({ ClientId: clientId, ...body }),
      });
    } catch {
      throw new CognitoError("network", "réseau");
    }
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new CognitoError(String(out.__type || "").split("#").pop() || "unknown", out.message || out.Message || "");
    return out;
  }

  let session = read();
  function read() {
    try {
      const s = JSON.parse(storage.getItem(KEY) || "null");
      return s && s.access && s.refresh ? s : null;
    } catch {
      return null;
    }
  }
  function keep(result, email) {
    const prev = session || {};
    session = {
      email: email || prev.email || "",
      access: result.AccessToken,
      refresh: result.RefreshToken || prev.refresh,
      expiresAt: now() + (Number(result.ExpiresIn) || 3600) * 1000,
    };
    try {
      storage.setItem(KEY, JSON.stringify(session));
    } catch {} // stockage refusé : la session vit le temps de la page
    return session;
  }
  function forget() {
    session = null;
    try {
      storage.removeItem(KEY);
    } catch {}
  }

  // Réponse de Cognito → { done: true } (connecté) ou { challenge, session } (code attendu)
  async function settle(out, email) {
    if (out.AuthenticationResult) {
      keep(out.AuthenticationResult, email);
      return { done: true };
    }
    if (out.ChallengeName === "SELECT_CHALLENGE") {
      // le groupe propose plusieurs façons de se connecter : on choisit le code par e-mail
      const next = await call("RespondToAuthChallenge", { ChallengeName: "SELECT_CHALLENGE", Session: out.Session, ChallengeResponses: { USERNAME: email, ANSWER: "EMAIL_OTP" } });
      return settle(next, email);
    }
    if (out.ChallengeName === "EMAIL_OTP") return { challenge: "EMAIL_OTP", session: out.Session, to: (out.ChallengeParameters && out.ChallengeParameters.CODE_DELIVERY_DESTINATION) || "" };
    throw new CognitoError("unsupported", `défi non pris en charge : ${out.ChallengeName}`);
  }

  return {
    get email() {
      return session ? session.email : "";
    },
    get signedIn() {
      return !!session;
    },
    // Connexion : envoie un code à l'adresse. Renvoie { challenge, session }.
    async startSignIn(email) {
      return settle(await call("InitiateAuth", { AuthFlow: "USER_AUTH", AuthParameters: { USERNAME: email, PREFERRED_CHALLENGE: "EMAIL_OTP" } }), email);
    },
    // Code reçu pour une connexion. Un code faux laisse la même session utilisable pour un nouvel essai.
    async answerSignIn(email, cognitoSession, code) {
      return settle(await call("RespondToAuthChallenge", { ChallengeName: "EMAIL_OTP", Session: cognitoSession, ChallengeResponses: { USERNAME: email, EMAIL_OTP_CODE: code } }), email);
    },
    // Inscription : crée le compte (e-mail seul, pas de mot de passe) ; Cognito envoie un code de confirmation.
    async startSignUp(email) {
      await call("SignUp", { Username: email, UserAttributes: [{ Name: "email", Value: email }] });
      return { challenge: "SIGN_UP" };
    },
    async resendSignUp(email) {
      await call("ResendConfirmationCode", { Username: email });
    },
    // Code reçu pour une inscription : confirme le compte puis connecte sans second code (session de ConfirmSignUp).
    async answerSignUp(email, code) {
      const out = await call("ConfirmSignUp", { Username: email, ConfirmationCode: code });
      if (!out.Session) return this.startSignIn(email); // groupe sans connexion après confirmation : un code de connexion suit
      return settle(await call("InitiateAuth", { AuthFlow: "USER_AUTH", AuthParameters: { USERNAME: email, PREFERRED_CHALLENGE: "EMAIL_OTP" }, Session: out.Session }), email);
    },
    // Jeton d'accès valable au moins une minute, renouvelé au besoin ; null si la session est perdue.
    async accessToken() {
      if (!session) return null;
      if (session.expiresAt - now() > 60_000) return session.access;
      try {
        const out = await call("InitiateAuth", { AuthFlow: "REFRESH_TOKEN_AUTH", AuthParameters: { REFRESH_TOKEN: session.refresh } });
        keep(out.AuthenticationResult);
        return session.access;
      } catch (e) {
        if (e.code !== "network") forget();
        return null;
      }
    },
    async signOut() {
      const refresh = session && session.refresh;
      forget();
      if (refresh) await call("RevokeToken", { Token: refresh }).catch(() => {});
    },
    forget,
  };
}

function safeStorage() {
  try {
    return window.sessionStorage;
  } catch {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
  }
}
