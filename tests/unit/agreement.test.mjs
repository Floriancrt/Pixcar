// Accord de sous-traitance des données (docs/sous-traitance.md) : le texte et sa version vont ensemble (src/partials/sous-traitance.html,
// src/js/shared/agreement.js). Un texte changé sans nouvelle empreinte échoue ici : c'est le moment de décider s'il faut une nouvelle
// version (déjà accepté par un garage : oui, pour la lui redemander).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { AGREEMENT, AGREEMENT_PROOF_YEARS, agreementView } from "../../src/js/shared/agreement.js";

const TEXT = readFileSync(new URL("../../src/partials/sous-traitance.html", import.meta.url), "utf8");

test("the text and its fingerprint go together: change one, change the other (and the version if a garage already accepted)", () => {
  assert.equal(createHash("sha256").update(TEXT).digest("hex"), AGREEMENT.sha256, "texte changé : mettre à jour AGREEMENT.sha256, et AGREEMENT.version s'il a déjà été accepté");
});

test("the version is a date, said the same way in the label", () => {
  assert.match(AGREEMENT.version, /^\d{4}-\d\d-\d\d$/);
  const label = new Date(AGREEMENT.version + "T12:00:00Z").toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Paris" });
  assert.equal(AGREEMENT.label, `version du ${label}`);
  assert.ok(Object.isFrozen(AGREEMENT));
});

test("the text covers what article 28(3) of the GDPR requires, and only placeholders the build fills", () => {
  // a) instructions, b) confidentialité, c) sécurité, d) sous-traitants, e) droits des personnes, f) violation et aide, g) fin, h) audits
  for (const h of ["Les instructions du garage", "Confidentialité", "Sécurité", "Sous-traitants ultérieurs", "Les droits des personnes", "Violation de données", "Fin de l'accord et sort des données", "Preuves et audits"])
    assert.ok(TEXT.includes(`. ${h}</h3>`), h);
  // objet, durée, nature, finalité, types de données, catégories de personnes (article 28, paragraphe 3, premier alinéa)
  for (const w of ["Objet, nature et durée", "son personnel", "ses clients", "Durées de conservation"]) assert.ok(TEXT.includes(w), w);
  assert.deepEqual([...new Set(TEXT.match(/\{\{[A-Z_]+\}\}/g))].sort(), ["{{CONTACT}}", "{{EDITOR}}", "{{HOST_API}}"]);
  // les durées dites ici sont celles du code (purges) et de la politique de confidentialité
  assert.ok(TEXT.includes("30 jours après le jour du rendez-vous") && TEXT.includes("supprimé 24 mois après") && TEXT.includes("Historique des changements : 12 mois"));
  assert.ok(TEXT.includes("Sauvegardes : 30 jours"));
});

test("a draft says so in the text; the mention goes with the draft flag", () => {
  assert.equal((TEXT.match(/data-dpa-draft/g) || []).length, 1, "une mention de projet, retirée par la construction quand draft est false");
});

test("what the API shows: the version in force, and once accepted, when and by whom", () => {
  assert.deepEqual(agreementView(null), { version: AGREEMENT.version, label: AGREEMENT.label, draft: AGREEMENT.draft, accepted: false });
  assert.deepEqual(agreementView({ acceptedAt: "2026-10-27T08:00:00.000Z", signer: "Camille Durand" }), {
    version: AGREEMENT.version,
    label: AGREEMENT.label,
    draft: AGREEMENT.draft,
    accepted: true,
    acceptedAt: "2026-10-27T08:00:00.000Z",
    signer: "Camille Durand",
  });
  assert.equal(AGREEMENT_PROOF_YEARS, 5);
});
