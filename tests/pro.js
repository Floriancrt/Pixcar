// Espace Pro (dist/pro/) de bout en bout : page construite pour de bon, servie avec ses en-têtes (_headers), vraie API (PGlite) avec l'Espace Pro
// ouvert, registre des entreprises simulé, Amazon Cognito simulé par cette suite (inscription et connexion sans mot de passe, code par e-mail).
// Parcours : inscription → code → rattachement d'un garage (SIRET, « Qui êtes-vous ? », choix du moyen, code) → tableau de bord ; déconnexion,
// reconnexion, session expirée ; accessibilité (axe) de chaque écran ; politique de sécurité (en-têtes et balise <meta> de la version publiée).
//   node tests/pro.js
delete process.env.PIXCAR_ROOT;
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { ROOT } = require("./harness");
const { serveDir } = require("./static-server");
const { startApi } = require("./api-harness");

const results = [];
const check = (name, cond, detail = "") => {
  results.push({ name, ok: !!cond });
  if (!cond) console.log("  FAIL:", name, "|", String(detail).slice(0, 600));
};
const AXE = fs.readFileSync(path.join(ROOT, "node_modules/axe-core/axe.min.js"), "utf8");
const OUT = path.join(__dirname, ".out", "pro-site");
const SHOTS = path.join(__dirname, ".out", "shots");
const SRC = process.env.PIXCAR_SRC || path.join(ROOT, "src");
const BUILD = process.env.PIXCAR_BUILD ? path.resolve(ROOT, process.env.PIXCAR_BUILD) : path.join(ROOT, "scripts/build.mjs");
const POOL = "eu-north-1_PixcarTest1";
const CLIENT = "4pro0test1client2id3";
const COGNITO = "https://cognito-idp.eu-north-1.amazonaws.com/";
const LEGAL = { editorLine: "Pixcar est édité à titre non professionnel par Jeanne Exemple, responsable du traitement des données décrites ici.", contact: "contact@exemple.test", hostPages: "GitHub, Inc. (GitHub Pages), États-Unis", hostApi: "Amazon Web Services EMEA SARL, Luxembourg (région Europe, Stockholm)", repairRetentionMonths: 24, updated: "3 octobre 2026" };

// ---- données : un garage avec e-mail public, site propre et portable ; un voisin déjà rattaché ; un établissement au registre
const HERE = { lat: 43.2174, lon: 1.1014 };
const north = (m) => ({ lat: HERE.lat + m / 111320, lon: HERE.lon });
const CONTACTS = [
  { id: "aaaaaaaa-0000-4000-8000-000000000001", name: "Garage Démo Centre", addr: "12 rue de l'Exemple, 31220 Cazères", pc: "31220", ...HERE, emails: ["contact@garage-demo.fr"], phones: ["+33561000001", "+33612345678"], web: "https://www.garage-demo.fr/" },
  { id: "aaaaaaaa-0000-4000-8000-000000000002", name: "Centre Auto Démo", addr: "3 avenue Fictive, 31220 Cazères", pc: "31220", ...north(120), emails: ["atelier@centre-auto-demo.fr"] },
];
function siretOf(prefix13) {
  for (let k = 0; k <= 9; k++) {
    const s = prefix13 + k;
    let sum = 0;
    for (let i = 0; i < 14; i++) {
      let d = Number(s[13 - i]);
      if (i % 2 === 1) (d *= 2) > 9 && (d -= 9);
      sum += d;
    }
    if (sum % 10 === 0) return s;
  }
}
const SIRET = siretOf("9876543210001");
const REGISTRY = { [SIRET]: { siret: SIRET, name: "GARAGE DEMO CENTRE", company: "DEMO SARL", addr: "12 RUE DE L'EXEMPLE 31220 CAZERES", naf: "45.20A", active: true, pc: "31220", ...north(30) } };

// ---- Amazon Cognito simulé (API JSON « AWSCognitoIdentityProviderService.* »)
function fakeCognito() {
  const users = new Map(); // e-mail → { sub, confirmed }
  const sessions = new Map(); // session → { email, code }
  const mail = []; // codes « envoyés » : { email, code, kind }
  const calls = [];
  let n = 0;
  const err = (type, message) => ({ status: 400, body: { __type: type, message } });
  const tokens = (email) => ({ AuthenticationResult: { AccessToken: `tok.${users.get(email).sub}.${++n}`, IdToken: "id." + n, RefreshToken: "ref." + users.get(email).sub, ExpiresIn: 3600, TokenType: "Bearer" } });
  const code = () => String(100000 + ((n++ * 7919) % 900000));
  function handle(action, b) {
    calls.push(action);
    if (b.ClientId !== CLIENT) return err("ResourceNotFoundException", "client inconnu");
    const email = String((b.AuthParameters && b.AuthParameters.USERNAME) || b.Username || (b.ChallengeResponses && b.ChallengeResponses.USERNAME) || "").toLowerCase();
    switch (action) {
      case "SignUp": {
        if (b.Password) return err("InvalidParameterException", "pas de mot de passe attendu");
        if (users.has(email)) return err("UsernameExistsException", "User already exists");
        users.set(email, { sub: "sub-" + users.size + 1, confirmed: false, code: code() });
        mail.push({ email, code: users.get(email).code, kind: "signup" });
        return { status: 200, body: { UserConfirmed: false, UserSub: users.get(email).sub } };
      }
      case "ConfirmSignUp": {
        const u = users.get(email);
        if (!u || b.ConfirmationCode !== u.code) return err("CodeMismatchException", "Invalid code");
        u.confirmed = true;
        const s = "confirm-" + ++n;
        sessions.set(s, { email, confirmed: true });
        return { status: 200, body: { Session: s } };
      }
      case "InitiateAuth": {
        if (b.AuthFlow === "REFRESH_TOKEN_AUTH") {
          const u = [...users.entries()].find(([, v]) => "ref." + v.sub === b.AuthParameters.REFRESH_TOKEN);
          return u ? { status: 200, body: { AuthenticationResult: { AccessToken: `tok.${u[1].sub}.${++n}`, ExpiresIn: 3600 } } } : err("NotAuthorizedException", "Invalid Refresh Token");
        }
        if (b.AuthFlow !== "USER_AUTH") return err("InvalidParameterException", "flow");
        if (b.Session) {
          const s = sessions.get(b.Session);
          return s && s.confirmed && s.email === email ? { status: 200, body: tokens(email) } : err("NotAuthorizedException", "Invalid session");
        }
        const u = users.get(email);
        if (!u || !u.confirmed) return err("UserNotFoundException", "User does not exist.");
        if (b.AuthParameters.PREFERRED_CHALLENGE !== "EMAIL_OTP") return err("InvalidParameterException", "challenge");
        const s = "otp-" + ++n;
        sessions.set(s, { email, code: code() });
        mail.push({ email, code: sessions.get(s).code, kind: "signin" });
        return { status: 200, body: { ChallengeName: "EMAIL_OTP", Session: s, ChallengeParameters: { CODE_DELIVERY_DESTINATION: "c***@g***" } } };
      }
      case "RespondToAuthChallenge": {
        const s = sessions.get(b.Session);
        if (!s || b.ChallengeName !== "EMAIL_OTP") return err("NotAuthorizedException", "Invalid session");
        if (b.ChallengeResponses.EMAIL_OTP_CODE !== s.code) return err("CodeMismatchException", "Invalid code");
        sessions.delete(b.Session);
        return { status: 200, body: tokens(email) };
      }
      case "RevokeToken":
        return { status: 200, body: {} };
      default:
        return err("InvalidAction", action);
    }
  }
  return { users, mail, calls, handle, last: (email) => [...mail].reverse().find((m) => m.email === email).code };
}

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, "empty"), { recursive: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  const srv = await serveDir(path.join(OUT, "empty"));
  const { AuthError } = await import("../server/lib/jwt.mjs");
  const { parseContactRows } = await import("../server/lib/contact.mjs");
  const api = await startApi({
    origin: srv.url,
    env: { PRO_ENABLED: "1" },
    proOptions: {
      verifier: async (token) => {
        const m = /^tok\.(sub-[\w-]+)\.\d+$/.exec(token);
        if (!m) throw new AuthError("jeton refusé");
        return { sub: m[1] };
      },
      sirene: async (siret) => REGISTRY[siret] || null,
    },
  });
  await api.app.pro.repo.upsertContacts(parseContactRows(CONTACTS).rows, "test");
  // le voisin est déjà géré par un autre compte
  await api.db.query("INSERT INTO pro_claims (id, account_id, garage_id, siret, status, channel, holder_name, holder_role, target_hash, target_hint, verified_at) VALUES (gen_random_uuid(), 'someone-else', $1, $2, 'verified', 'email', 'Autre Personne', 'manager', $3, 'a•••••@centre-auto-demo.fr', now())", [CONTACTS[1].id, SIRET, "b".repeat(64)]);

  // ---- construction : sources copiées avec des mentions légales complètes (valeurs fictives)
  const src = path.join(OUT, "src");
  fs.cpSync(SRC, src, { recursive: true });
  fs.writeFileSync(path.join(src, "legal.json"), JSON.stringify(LEGAL));
  const env = { ...process.env, PIXCAR_API_BASE: api.url, PIXCAR_PRO_POOL: POOL, PIXCAR_PRO_CLIENT: CLIENT, PIXCAR_GA_ID: "", PIXCAR_CS_ID: "", PIXCAR_MAPBOX_TOKEN: "" };
  const build = (name, extra = [], e = env) => execFileSync(process.execPath, [BUILD, "--only", "dist", "--src", src, "--out", path.join(OUT, name), ...extra], { stdio: "pipe", env: e });
  build("site");
  const dist = path.join(OUT, "site", "dist");
  srv.setRoot(dist);

  // sans identifiants Cognito, ou sans API : pas de page pro (et une configuration incohérente arrête le build)
  build("plain", [], { ...env, PIXCAR_PRO_POOL: "", PIXCAR_PRO_CLIENT: "" });
  check("without Cognito settings the site has no pro/ page and no trace of Cognito", !fs.existsSync(path.join(OUT, "plain/dist/pro")) && !/cognito/.test(fs.readFileSync(path.join(OUT, "plain/dist/_headers"), "utf8")));
  // texte de confidentialité : la section « Espace Pro » n'existe que dans le site qui a la page pro/, jamais dans la page tout-en-un
  const legalPro = (file) => /id="lg-pro"/.test(fs.readFileSync(file, "utf8"));
  execFileSync(process.execPath, [BUILD, "--only", "single", "--src", src, "--out", path.join(OUT, "single")], { stdio: "pipe", env });
  check("privacy text: an « Espace Pro » section in the site that has the pro page, none without it, none in the all-in-one page", legalPro(path.join(dist, "index.html")) && !legalPro(path.join(OUT, "plain/dist/index.html")) && !legalPro(path.join(OUT, "single/index.html")));
  let refused = "";
  try {
    build("noapi", [], { ...env, PIXCAR_API_BASE: "" });
  } catch (e) {
    refused = String(e.stderr || e.message);
  }
  check("a pro page without the API is refused at build time", /Espace Pro : la page pro\/ a besoin de l'API/.test(refused), refused);
  try {
    build("badpool", [], { ...env, PIXCAR_PRO_POOL: "pool" });
    refused = "";
  } catch (e) {
    refused = String(e.stderr || e.message);
  }
  check("a malformed user pool id is refused at build time", /groupe d'utilisateurs Cognito invalide/.test(refused), refused);
  // version publiée (GitHub Pages) : la page pro porte sa propre politique, étroite
  build("pages", ["--pages", "pixcar.example"]);
  const pagesHtml = fs.readFileSync(path.join(OUT, "pages/dist/pro/index.html"), "utf8");
  const meta = (/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(pagesHtml) || [])[1] || "";
  check("published pro page: its own CSP, connect-src = the API and Cognito only, no inline script or style", meta.includes(`connect-src ${new URL(api.url).origin} https://cognito-idp.eu-north-1.amazonaws.com;`) && /script-src 'self';/.test(meta) && /style-src 'self';/.test(meta) && !/unsafe-inline/.test(meta), meta);
  check("published pro page: not indexed, no inline <script> or <style>", /<meta name="robots" content="noindex">/.test(pagesHtml) && !/<script>(?!<\/)/.test(pagesHtml) && !/<style>/.test(pagesHtml));
  const robots = fs.readFileSync(path.join(dist, "robots.txt"), "utf8");
  check("robots.txt keeps crawlers out of /pro/", /Disallow: \/pro\//.test(robots), robots);

  // ---- navigateur
  const cognito = fakeCognito();
  const browser = await chromium.launch({ args: ["--proxy-server=direct://", "--proxy-bypass-list=*"] });
  const outside = [];
  async function newPage({ width = 1280, height = 900 } = {}) {
    const ctx = await browser.newContext({ viewport: { width, height }, locale: "fr-FR", serviceWorkers: "block" });
    await ctx.route("**/*", async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (url.href.startsWith(COGNITO)) {
        const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, x-amz-target, x-amz-user-agent", "access-control-allow-methods": "POST" };
        if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
        const action = String(req.headers()["x-amz-target"] || "").replace("AWSCognitoIdentityProviderService.", "");
        const out = cognito.handle(action, JSON.parse(req.postData() || "{}"));
        return route.fulfill({ status: out.status, headers: { ...cors, "content-type": "application/x-amz-json-1.1" }, body: JSON.stringify(out.body) });
      }
      if (url.hostname === "127.0.0.1") return route.continue();
      outside.push(url.href);
      return route.abort();
    });
    const page = await ctx.newPage();
    const logs = [];
    // les refus attendus de l'API et de Cognito (400, 401, 422) apparaissent dans la console comme « Failed to load resource » : ce ne sont pas des erreurs de la page
    page.on("console", (m) => ["error", "warning"].includes(m.type()) && !/^Failed to load resource: the server responded with a status of (400|401|422)\b/.test(m.text()) && logs.push(`[${m.type()}] ${m.text()}`));
    page.on("pageerror", (e) => logs.push("[pageerror] " + e.message));
    return { ctx, page, logs };
  }
  const axe = async (page, label) => {
    await page.evaluate(AXE);
    const r = await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] } })).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`));
    check(`axe: no violation on « ${label} »`, r.length === 0, r.join("\n"));
  };
  const visible = (page, screen) => page.locator(`[data-screen="${screen}"]`).isVisible();
  const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `pro-${name}.png`), fullPage: true });
  const EMAIL = "camille@garage-demo.fr";

  const { ctx, page, logs } = await newPage();
  const res = await page.goto(`${srv.url}/pro/#inscription`);
  const csp = res.headers()["content-security-policy"] || "";
  check("served with the site headers: the CSP lets the page talk to Cognito", csp.includes("https://cognito-idp.eu-north-1.amazonaws.com"), csp);
  await page.waitForSelector('[data-screen="login"]:not([hidden])');
  check("#inscription opens the sign-up form", (await page.locator("#signupTitle").isVisible()) && !(await page.locator("#loginTitle").isVisible()));
  await axe(page, "inscription");
  await shot(page, "1-inscription");

  // inscription : e-mail invalide, puis le bon
  await page.fill("#email", "pas-un-mail");
  await page.click("#loginBtn");
  check("an invalid e-mail is caught before calling Cognito", (await page.textContent("#emailErr")).includes("invalide") && !cognito.calls.length);
  await page.fill("#email", EMAIL);
  await page.click("#loginBtn");
  await page.waitForSelector('[data-screen="otp"]:not([hidden])');
  check("sign-up: Cognito gets SignUp without any password, the code screen names the address", cognito.calls.join() === "SignUp" && (await page.textContent("#otpTo")) === EMAIL);
  await page.fill("#otp", "000000");
  await page.click('#otpForm button[type="submit"]');
  await page.waitForFunction(() => !document.getElementById("otpErr").hidden);
  check("a wrong e-mail code says so, in French", (await page.textContent("#otpErr")).includes("Code incorrect"));
  await page.fill("#otp", cognito.last(EMAIL));
  await page.click('#otpForm button[type="submit"]');
  await page.waitForSelector('[data-screen="home"]:not([hidden])');
  check("confirmed and signed in at once (ConfirmSignUp session, no second code)", cognito.calls.slice(-2).join() === "ConfirmSignUp,InitiateAuth" && cognito.mail.length === 1, cognito.calls.join());
  check("dashboard: no garage yet, the account is shown in the header", (await page.locator("#noGarage").isVisible()) && (await page.textContent("#accountEmail")) === EMAIL);
  const stored = await page.evaluate(() => [Object.keys(sessionStorage), Object.keys(localStorage), document.cookie]);
  check("tokens live in sessionStorage only (no localStorage, no cookie)", stored[0].includes("pixcar-pro-session") && !stored[1].length && !stored[2], JSON.stringify(stored));
  await axe(page, "tableau de bord vide");

  // étape 1 : SIRET
  await page.click('[data-screen="home"] [data-go="garage"]');
  check("the steps appear, step 1 is current", (await page.locator("#steps").isVisible()) && (await page.getAttribute('[data-step="garage"]', "aria-current")) === "step");
  await page.fill("#siret", "123");
  await page.click('#siretForm button[type="submit"]');
  check("a SIRET that is not 14 digits is refused on the page", (await page.textContent("#siretErr")).includes("14 chiffres"));
  await page.fill("#siret", "12345678901234");
  await page.click('#siretForm button[type="submit"]');
  await page.waitForFunction(() => !document.getElementById("siretErr").hidden && /SIRET/.test(document.getElementById("siretErr").textContent));
  check("a SIRET with a wrong key: the API's message is shown", (await page.textContent("#siretErr")).includes("clé de contrôle"));
  await page.fill("#siret", `${SIRET.slice(0, 3)} ${SIRET.slice(3, 6)} ${SIRET.slice(6, 9)} ${SIRET.slice(9)}`);
  await page.click('#siretForm button[type="submit"]');
  await page.waitForSelector("#siretResult:not([hidden])");
  const choices = await page.$$eval("#garageOptions .choice", (els) => els.map((e) => [e.querySelector("b").textContent, e.querySelector("input").disabled, e.querySelector("input").checked, e.querySelector("small").textContent]));
  check(
    "establishment found; its garage is preselected with its means counted; the neighbour already managed by someone else cannot be chosen",
    (await page.textContent("#etabName")) === "GARAGE DEMO CENTRE" && choices[0][0] === "Garage Démo Centre" && choices[0][2] && /3 moyens/.test(choices[0][3]) && choices[1][1] && /autre compte/.test(choices[1][3]),
    JSON.stringify(choices),
  );
  await axe(page, "SIRET trouvé");
  await shot(page, "2-siret");
  await page.click("#pickGarage");

  // étape 2 : la personne
  await page.waitForSelector('[data-screen="you"]:not([hidden])');
  check("step 2 names the garage and shows the account e-mail read-only", (await page.textContent("#youGarage")) === "Garage Démo Centre" && (await page.inputValue("#youEmail")) === EMAIL && (await page.getAttribute("#youEmail", "readonly")) !== null);
  await page.fill("#firstName", "Camille");
  await page.fill("#lastName", "Durand");
  await page.click('#youForm button[type="submit"]');
  check("the certification box is required", (await page.textContent("#youErr")).includes("Cochez"));
  await page.check("#certify");
  await page.click('#youForm button[type="submit"]');
  await page.waitForSelector('[data-screen="verify"]:not([hidden])');
  await axe(page, "Qui êtes-vous");

  // étape 3 : choix du moyen
  const opts = await page.$$eval("#channelOptions .choice", (els) => els.map((e) => e.innerText.replace(/\s+/g, " ").trim()));
  check("three means offered, all masked: public e-mail, an address on the garage's own domain, SMS", opts.length === 3 && /E-mail public du garage c•••••@garage-demo\.fr/.test(opts[0]) && /@garage-demo\.fr/.test(opts[1]) && /SMS au portable du garage 06 •• •• •• 78/.test(opts[2]), opts.join(" / "));
  check("nothing in the page reveals the real address or number", !/contact@garage-demo|612345678/.test(await page.content()));
  await page.click('#channelForm button[type="submit"]');
  check("a means must be chosen (none preselected when there are several)", (await page.textContent("#channelErr")).includes("Choisissez"));
  await page.focus("#localPart");
  await page.click('#channelForm button[type="submit"]');
  check("focusing the local-part field selects the domain option; an empty local part is refused", (await page.isChecked('input[name="channel"][value="domain"]')) && (await page.textContent("#channelErr")).includes("avant le @"));
  await axe(page, "choix du moyen");
  await shot(page, "3-moyen");
  await page.check('input[name="channel"][value="sms:1"]');
  await page.click('#channelForm button[type="submit"]');
  await page.waitForSelector('[data-screen="code"]:not([hidden])');
  const outbox = api.app.pro.senders.outbox;
  check("the code left by SMS to the garage's mobile, never to anything typed on the page", outbox.length === 1 && outbox[0].channel === "sms" && outbox[0].target === "+33612345678", JSON.stringify(outbox));
  check("code screen: where the code went (masked), resend locked for 60 s", (await page.textContent("#codeWhere")) === "par SMS au 06 •• •• •• 78" && (await page.isDisabled("#resend")) && /dans 1:00|dans 0:5\d/.test(await page.textContent("#resendIn")), await page.textContent("#resendIn"));
  await axe(page, "saisie du code");
  await shot(page, "4-code");
  const good = outbox[0].code;
  await page.fill("#code", String((Number(good) + 1) % 1e6).padStart(6, "0"));
  await page.click('#codeForm button[type="submit"]');
  await page.waitForFunction(() => !document.getElementById("codeErr").hidden);
  check("a wrong code: « Encore 4 essais »", (await page.textContent("#codeErr")).includes("Encore 4 essais"));
  await page.fill("#code", good);
  await page.click('#codeForm button[type="submit"]');
  await page.waitForSelector('[data-screen="done"]:not([hidden])');
  check("verified: step 4, the garage named", (await page.textContent("#doneGarage")) === "Garage Démo Centre" && (await page.getAttribute('[data-step="done"]', "aria-current")) === "step");
  const row = (await api.db.query("SELECT status, holder_name, holder_role, account_id FROM pro_claims WHERE account_id LIKE 'sub-%'")).rows[0];
  check("in the database: verified, with the person's name and role, under the Cognito account", row && row.status === "verified" && row.holder_name === "Camille Durand" && row.holder_role === "manager", JSON.stringify(row));
  await axe(page, "garage vérifié");
  await shot(page, "5-fait");
  await page.click('[data-screen="done"] [data-go="home"]');
  await page.waitForSelector('[data-screen="home"]:not([hidden])');
  const items = await page.$$eval("#garageList li", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
  check("dashboard lists the garage as verified", items.length === 1 && /Garage Démo Centre.*Vérifié/.test(items[0]), items.join(" / "));
  await axe(page, "tableau de bord");
  await shot(page, "6-tableau");

  // déconnexion, puis reconnexion (compte existant : code de connexion)
  await page.click("#signOut");
  await page.waitForSelector('[data-screen="login"]:not([hidden])');
  check("sign out: back to the login form, session forgotten, refresh token revoked", (await page.evaluate(() => sessionStorage.getItem("pixcar-pro-session"))) === null && cognito.calls.includes("RevokeToken") && (await page.locator("#account").isHidden()));
  await page.fill("#email", EMAIL);
  await page.click("#loginBtn");
  await page.waitForSelector('[data-screen="otp"]:not([hidden])');
  await page.fill("#otp", cognito.last(EMAIL));
  await page.click('#otpForm button[type="submit"]');
  await page.waitForSelector('[data-screen="home"]:not([hidden])');
  check("sign in again by e-mail code: the garage is still there", (await page.$$eval("#garageList li", (els) => els.length)) === 1);

  // « Gérer mon garage » avec une adresse déjà inscrite : on bascule sur la connexion
  await page.click("#signOut");
  await page.click('[data-mode="signup"]');
  await page.fill("#email", EMAIL);
  const before = cognito.calls.length;
  await page.click("#loginBtn");
  await page.waitForSelector('[data-screen="otp"]:not([hidden])');
  check("signing up with an address that already has an account turns into a sign-in", cognito.calls.slice(before).join() === "SignUp,InitiateAuth", cognito.calls.slice(before).join());
  await page.fill("#otp", cognito.last(EMAIL));
  await page.click('#otpForm button[type="submit"]');
  await page.waitForSelector('[data-screen="home"]:not([hidden])');

  // session refusée par l'API (jeton révoqué côté serveur) : retour propre à la connexion
  await page.evaluate(() => {
    const s = JSON.parse(sessionStorage.getItem("pixcar-pro-session"));
    s.access = "jeton-refuse";
    sessionStorage.setItem("pixcar-pro-session", JSON.stringify(s));
  });
  await page.reload();
  await page.waitForSelector('[data-screen="login"]:not([hidden])');
  check("a token the API refuses: back to login with a message", (await page.textContent("#alert")).includes("session a expiré"));
  check("no console error, no page error", !logs.length, logs.join("\n"));
  await ctx.close();

  // ---- mobile
  {
    const m = await newPage({ width: 390, height: 844 });
    await m.page.goto(`${srv.url}/pro/`);
    await m.page.waitForSelector('[data-screen="login"]:not([hidden])');
    const overflow = await m.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check("mobile (390 px): no horizontal scroll", overflow <= 0, overflow);
    await shot(m.page, "7-mobile-connexion");
    await m.ctx.close();
  }
  check("nothing but the site, the API and Cognito was contacted", !outside.length, outside.join("\n"));

  await browser.close();
  await api.close();
  srv.close && srv.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} cas passés`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
