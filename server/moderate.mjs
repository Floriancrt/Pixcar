// Modération des déclarations en attente de relecture (prix très éloigné de ce que les autres ont déclaré).
//   DATABASE_URL=postgres://… node server/moderate.mjs list
//   DATABASE_URL=postgres://… node server/moderate.mjs approve <id> [<id>…]
//   DATABASE_URL=postgres://… node server/moderate.mjs reject  <id> [<id>…]
//   DATABASE_URL=postgres://… node server/moderate.mjs stats
// Une déclaration approuvée devient publique ; une déclaration rejetée n'est jamais renvoyée par l'API (elle reste en base,
// ce qui empêche la même plaque de la redéposer le même jour sous un autre identifiant : voir repairs_no_duplicate_idx).
import { createDb } from "./db.mjs";
import { createRepo } from "./repo.mjs";

const [command, ...ids] = process.argv.slice(2);
const db = await createDb({ url: process.env.DATABASE_URL || "", dataDir: process.env.DEV_DATA_DIR || undefined });
const repo = createRepo(db);
try {
  if (command === "list") {
    const rows = await repo.listPending(100);
    if (!rows.length) console.log("Rien en attente.");
    for (const r of rows) console.log(`${r.id}  ${r.date}  ${(r.price_cents / 100).toFixed(2).padStart(9)} €  ${r.service_id.padEnd(12)}  ${r.garage_name} (${r.garage_id})  ${r.vehicle_model} ${r.vehicle_year}  note ${r.rating}/5${r.comment ? "  « " + r.comment + " »" : ""}`);
  } else if (command === "approve" || command === "reject") {
    if (!ids.length) throw new Error(`usage : moderate.mjs ${command} <id> [<id>…]`);
    for (const id of ids) console.log(`${id} : ${(await repo.setStatus(id, command === "approve" ? "approved" : "rejected")) ? "ok" : "introuvable"}`);
  } else if (command === "stats") {
    console.log(await repo.stats());
  } else {
    console.error("Commandes : list · approve <id>… · reject <id>… · stats");
    process.exitCode = 2;
  }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await db.close();
}
