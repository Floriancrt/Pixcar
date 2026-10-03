// Modération des déclarations et effacement à la demande d'une personne.
//   DATABASE_URL=postgres://… node server/moderate.mjs list
//   DATABASE_URL=postgres://… node server/moderate.mjs approve <id> [<id>…]
//   DATABASE_URL=postgres://… node server/moderate.mjs reject  <id> [<id>…]
//   DATABASE_URL=postgres://… node server/moderate.mjs stats
//   DATABASE_URL=postgres://… PLATE_PEPPER=… node server/moderate.mjs forget <plaque> [<plaque>…]
// Une déclaration approuvée devient publique ; une déclaration rejetée n'est jamais renvoyée par l'API (elle reste en base,
// ce qui empêche la même plaque de la redéposer le même jour sous un autre identifiant : voir repairs_no_duplicate_idx).
// « forget » supprime pour de bon toutes les déclarations d'une plaque, rejetées comprises : la plaque n'étant stockée que
// sous forme d'empreinte, il faut le MÊME PLATE_PEPPER que l'API (sinon l'empreinte ne correspond à rien : 0 supprimée).
import { fileURLToPath } from "node:url";
import { createDb } from "./db.mjs";
import { hmac, toHex } from "./lib/crypto.mjs";
import { createRepo } from "./repo.mjs";
import { PLATE_RE } from "../src/js/shared/rules.js";

// « ab 123 cd », « AB123CD », « ab-123-cd » → « AB-123-CD » ; autre chose : erreur
export function normalizePlate(text) {
  const m = /^([A-Z]{2})(\d{3})([A-Z]{2})$/.exec(String(text).toUpperCase().replace(/[\s.\-–—_/]+/g, ""));
  const plate = m && `${m[1]}-${m[2]}-${m[3]}`;
  if (!plate || !PLATE_RE.test(plate)) throw new Error(`« ${text} » n'est pas une plaque au format AB-123-CD`);
  return plate;
}

// Renvoie le code de sortie. `out` reçoit les lignes d'information.
export async function moderate([command, ...args], { db, plateSecret = "", out = console.log, err = console.error }) {
  const repo = createRepo(db);
  if (command === "list") {
    const rows = await repo.listPending(100);
    if (!rows.length) out("Rien en attente.");
    for (const r of rows) out(`${r.id}  ${r.date}  ${(r.price_cents / 100).toFixed(2).padStart(9)} €  ${r.service_id.padEnd(12)}  ${r.garage_name} (${r.garage_id})  ${r.vehicle_model} ${r.vehicle_year}  note ${r.rating}/5${r.comment ? "  « " + r.comment + " »" : ""}`);
  } else if (command === "approve" || command === "reject") {
    if (!args.length) throw new Error(`usage : moderate.mjs ${command} <id> [<id>…]`);
    for (const id of args) out(`${id} : ${(await repo.setStatus(id, command === "approve" ? "approved" : "rejected")) ? "ok" : "introuvable"}`);
  } else if (command === "stats") {
    out(await repo.stats());
  } else if (command === "forget") {
    if (!args.length) throw new Error("usage : moderate.mjs forget <plaque> [<plaque>…]");
    if (plateSecret.length < 16) throw new Error("PLATE_PEPPER absent ou trop court : il faut le même secret que l'API");
    const plates = args.map(normalizePlate); // toutes les plaques sont vérifiées avant d'en supprimer une
    for (const plate of plates) out(`${plate} : ${await repo.deleteByPlate(toHex(await hmac(plateSecret, plate)))} déclaration(s) supprimée(s)`);
  } else {
    err("Commandes : list · approve <id>… · reject <id>… · stats · forget <plaque>…");
    return 2;
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dsql = process.env.DSQL_ENDPOINT ? { endpoint: process.env.DSQL_ENDPOINT, user: process.env.DSQL_USER || "admin" } : null;
  const db = await createDb({ url: process.env.DATABASE_URL || "", dsql, dataDir: process.env.DEV_DATA_DIR || undefined });
  try {
    process.exitCode = await moderate(process.argv.slice(2), { db, plateSecret: process.env.PLATE_PEPPER || "" });
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}
