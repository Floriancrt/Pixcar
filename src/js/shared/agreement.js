// Accord de sous-traitance des données (article 28 du RGPD) entre le garage, responsable du traitement, et Pixcar, sous-traitant, pour
// la gestion d'atelier (docs/sous-traitance.md). Le texte est dans src/partials/sous-traitance.html. Une seule définition, partagée par
// l'API (dernier mot : elle refuse d'enregistrer le personnel, les absences et les rendez-vous saisis tant que le garage n'a pas accepté
// cette version) et la page Pro (fenêtre d'acceptation).
//   version  ce que le garage accepte ; à changer dès qu'un garage a accepté l'ancien texte, pour lui redemander son accord
//   sha256   empreinte du texte : un texte changé sans elle fait échouer tests/unit/agreement.test.mjs
//   draft    projet pas encore relu par un juriste : la construction publiée (--pages) le refuse
export const AGREEMENT = Object.freeze({
  version: "2026-10-26",
  label: "version du 26 octobre 2026",
  sha256: "552c933c70a9a7447843612959c273c957b3512489d80f0922dc96eadbea8ca7",
  draft: true,
});

// une preuve d'acceptation est gardée 5 ans après la fin du rattachement (docs/sous-traitance.md, questions au juriste)
export const AGREEMENT_PROOF_YEARS = 5;

// Ce que l'API montre au garage : la version en vigueur et, s'il l'a acceptée, quand et par qui (nom déclaré au rattachement).
export function agreementView(row) {
  return {
    version: AGREEMENT.version,
    label: AGREEMENT.label,
    draft: AGREEMENT.draft,
    accepted: !!row,
    ...(row ? { acceptedAt: row.acceptedAt, signer: row.signer } : {}),
  };
}
