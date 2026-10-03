// Secrets de l'API (empreintes des plaques et des adresses) : variables d'environnement si elles y sont (développement, tests,
// serveur classique), sinon paramètres chiffrés d'AWS Systems Manager (SSM Parameter Store, SecureString), lus UNE fois au démarrage
// de la fonction. Ils ne sont jamais écrits dans la configuration de la fonction, donc pas visibles dans la console Lambda.
//   SSM_PREFIX=/pixcar/prod/   →  /pixcar/prod/PLATE_PEPPER, /pixcar/prod/IP_PEPPER
const NAMES = ["PLATE_PEPPER", "IP_PEPPER"];

export async function readSecrets(env = process.env, { client, names = NAMES } = {}) {
  const missing = names.filter((n) => !env[n]);
  if (!missing.length) return {};
  if (!env.SSM_PREFIX) throw new Error(`secrets absents : ${missing.join(", ")} (ni variable d'environnement, ni SSM_PREFIX)`);
  const { SSMClient, GetParametersCommand } = client || (await import("@aws-sdk/client-ssm"));
  const ssm = new SSMClient({});
  const out = await ssm.send(new GetParametersCommand({ Names: missing.map((n) => env.SSM_PREFIX + n), WithDecryption: true }));
  if (out.InvalidParameters && out.InvalidParameters.length) throw new Error("paramètres SSM introuvables : " + out.InvalidParameters.join(", "));
  const found = {};
  for (const p of out.Parameters || []) found[p.Name.slice(env.SSM_PREFIX.length)] = p.Value;
  for (const n of missing) if (!found[n]) throw new Error(`paramètre SSM vide : ${env.SSM_PREFIX}${n}`);
  return found;
}
