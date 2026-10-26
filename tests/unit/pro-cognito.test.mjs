// Espace Pro, côté page : client Amazon Cognito (sans mot de passe) et client de l'API pro. Réseau et horloge simulés.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createCognito, explain } from "../../src/js/pro/cognito.js";
import { createProApi } from "../../src/js/pro/api.js";

const memory = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
};
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/x-amz-json-1.1" } });

function setup(script) {
  const calls = [];
  let clock = 1_000_000;
  const fetchImpl = async (url, init) => {
    const action = init.headers["x-amz-target"].replace("AWSCognitoIdentityProviderService.", "");
    calls.push({ url, action, body: JSON.parse(init.body) });
    const next = script.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  const storage = memory();
  const auth = createCognito({ userPoolId: "eu-north-1_Abc123", clientId: "client0123456", fetchImpl, storage, now: () => clock });
  return { auth, calls, storage, tick: (ms) => (clock += ms) };
}
const result = (n) => ({ AuthenticationResult: { AccessToken: "access-" + n, RefreshToken: "refresh-1", ExpiresIn: 3600 } });

describe("Cognito client (passwordless)", () => {
  test("sign-in: InitiateAuth USER_AUTH with EMAIL_OTP to the pool's region, then the code; tokens kept in session storage", async () => {
    const { auth, calls, storage } = setup([reply(200, { ChallengeName: "EMAIL_OTP", Session: "s1", ChallengeParameters: { CODE_DELIVERY_DESTINATION: "c***@g***" } }), reply(200, result(1))]);
    const started = await auth.startSignIn("camille@garage.fr");
    assert.deepEqual(started, { challenge: "EMAIL_OTP", session: "s1", to: "c***@g***" });
    assert.equal(calls[0].url, "https://cognito-idp.eu-north-1.amazonaws.com/");
    assert.deepEqual(calls[0].body, { ClientId: "client0123456", AuthFlow: "USER_AUTH", AuthParameters: { USERNAME: "camille@garage.fr", PREFERRED_CHALLENGE: "EMAIL_OTP" } });
    assert.deepEqual(await auth.answerSignIn("camille@garage.fr", "s1", "123456"), { done: true });
    assert.deepEqual(calls[1].body.ChallengeResponses, { USERNAME: "camille@garage.fr", EMAIL_OTP_CODE: "123456" });
    assert.equal(auth.signedIn, true);
    assert.equal(auth.email, "camille@garage.fr");
    assert.equal(JSON.parse(storage.getItem("pixcar-pro-session")).access, "access-1");
    assert.equal(await auth.accessToken(), "access-1");
  });

  test("a pool that offers several first factors: the e-mail code is chosen (SELECT_CHALLENGE)", async () => {
    const { auth, calls } = setup([reply(200, { ChallengeName: "SELECT_CHALLENGE", Session: "s0" }), reply(200, { ChallengeName: "EMAIL_OTP", Session: "s1" })]);
    assert.equal((await auth.startSignIn("a@b.fr")).session, "s1");
    assert.deepEqual(calls[1].body.ChallengeResponses, { USERNAME: "a@b.fr", ANSWER: "EMAIL_OTP" });
  });

  test("sign-up: no password sent; confirmation code, then signed in with the ConfirmSignUp session (no second code)", async () => {
    const { auth, calls } = setup([reply(200, { UserConfirmed: false }), reply(200, { Session: "after-confirm" }), reply(200, result(2))]);
    await auth.startSignUp("new@garage.fr");
    assert.deepEqual(calls[0].body, { ClientId: "client0123456", Username: "new@garage.fr", UserAttributes: [{ Name: "email", Value: "new@garage.fr" }] });
    assert.deepEqual(await auth.answerSignUp("new@garage.fr", "654321"), { done: true });
    assert.deepEqual(calls.map((c) => c.action), ["SignUp", "ConfirmSignUp", "InitiateAuth"]);
    assert.equal(calls[2].body.Session, "after-confirm");
  });

  test("errors carry Cognito's code and a French explanation", async () => {
    const { auth } = setup([reply(400, { __type: "com.amazonaws#UserNotFoundException", message: "User does not exist." }), new TypeError("Failed to fetch")]);
    const e1 = await auth.startSignIn("x@y.fr").catch((e) => e);
    assert.equal(e1.code, "UserNotFoundException");
    assert.match(explain(e1), /Aucun accès/);
    const e2 = await auth.startSignIn("x@y.fr").catch((e) => e);
    assert.equal(e2.code, "network");
    assert.match(explain(e2), /réseau/);
    assert.match(explain({ code: "CodeMismatchException" }), /Code incorrect/);
  });

  test("access token renewed with the refresh token a minute before it expires; a refused refresh forgets the session, a network failure does not", async () => {
    const { auth, calls, storage, tick } = setup([reply(200, result(1)), reply(200, { AuthenticationResult: { AccessToken: "access-2", ExpiresIn: 3600 } }), new TypeError("offline"), reply(400, { __type: "NotAuthorizedException" })]);
    await auth.answerSignIn("a@b.fr", "s", "111111");
    tick(3_550_000);
    assert.equal(await auth.accessToken(), "access-2");
    assert.equal(calls[1].body.AuthParameters.REFRESH_TOKEN, "refresh-1");
    assert.equal(JSON.parse(storage.getItem("pixcar-pro-session")).refresh, "refresh-1", "le jeton de rafraîchissement reste");
    tick(3_600_000);
    assert.equal(await auth.accessToken(), null);
    assert.equal(auth.signedIn, true, "panne réseau : on garde la session");
    assert.equal(await auth.accessToken(), null);
    assert.equal(auth.signedIn, false, "refus : session oubliée");
    assert.equal(storage.getItem("pixcar-pro-session"), null);
  });

  test("sign out revokes the refresh token and forgets everything, even when Cognito does not answer", async () => {
    const { auth, calls, storage } = setup([reply(200, result(1)), new TypeError("offline")]);
    await auth.answerSignIn("a@b.fr", "s", "111111");
    await auth.signOut();
    assert.equal(calls[1].action, "RevokeToken");
    assert.equal(calls[1].body.Token, "refresh-1");
    assert.equal(auth.signedIn, false);
    assert.equal(storage.getItem("pixcar-pro-session"), null);
  });
});

describe("Pro API client", () => {
  test("Bearer token on every call; errors keep the API's code, message and details", async () => {
    const seen = [];
    const api = createProApi({
      base: "https://api.test",
      token: async () => "tok",
      fetchImpl: async (url, init) => {
        seen.push([url, init.method, init.headers.authorization, init.body]);
        return url.endsWith("/code") ? new Response(JSON.stringify({ error: { code: "bad_code", message: "Code incorrect. Encore 4 essais.", attemptsLeft: 4 } }), { status: 422 }) : new Response(JSON.stringify({ ok: 1 }), { status: 200 });
      },
    });
    assert.deepEqual(await api.siret("12345678901234"), { ok: 1 });
    const e = await api.code("id-1", "123456").catch((x) => x);
    assert.deepEqual([e.status, e.code, e.message, e.details.attemptsLeft], [422, "bad_code", "Code incorrect. Encore 4 essais.", 4]);
    assert.deepEqual(seen[0], ["https://api.test/v1/pro/siret/12345678901234", "GET", "Bearer tok", undefined]);
    assert.deepEqual(seen[1], ["https://api.test/v1/pro/claims/id-1/code", "POST", "Bearer tok", '{"code":"123456"}']);
  });

  test("no token: no request, a 401 error; network failure: a « network » error", async () => {
    let called = false;
    const none = createProApi({ base: "https://api.test", token: async () => null, fetchImpl: async () => ((called = true), new Response("{}")) });
    assert.equal((await none.me().catch((e) => e)).status, 401);
    assert.equal(called, false);
    const down = createProApi({ base: "https://api.test", token: async () => "t", fetchImpl: async () => { throw new TypeError("Failed to fetch"); } });
    assert.equal((await down.me().catch((e) => e)).code, "network");
  });

  test("a write refused for want of the processing agreement calls the hook (its window opens), and still fails; other errors do not", async () => {
    let asked = 0, sent = null;
    const refuse = (code, status) => new Response(JSON.stringify({ error: { code, message: "…" } }), { status });
    const api = createProApi({
      base: "https://api.test",
      token: async () => "t",
      onAgreementRequired: () => asked++,
      fetchImpl: async (url, init) => {
        if (url.endsWith("/agreement")) return (sent = init.body), new Response(JSON.stringify({ accepted: true }), { status: 201 });
        return url.includes("/staff") ? refuse("agreement_required", 403) : refuse("validation", 422);
      },
    });
    const e = await api.saveStaff("g1", null, { name: "Paul" }).catch((x) => x);
    assert.deepEqual([e.status, e.code, asked], [403, "agreement_required", 1]);
    await api.saveBlock("g1", null, {}).catch(() => {});
    assert.equal(asked, 1, "une autre erreur ne l'appelle pas");
    assert.deepEqual(await api.acceptAgreement("g1", "2026-10-26"), { accepted: true });
    assert.equal(sent, '{"version":"2026-10-26","accept":true}');
  });
});
