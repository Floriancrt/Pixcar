# Accord de sous-traitance des données (article 28 du RGPD)

Pour les données que le garage confie à la gestion d'atelier (son personnel, les clients qu'il note lui-même), Pixcar agit pour son
compte, comme sous-traitant. L'article 28 du RGPD exige alors un contrat écrit, électronique possible (paragraphe 9), qui fixe l'objet,
la durée, la nature et la finalité du traitement, les types de données, les catégories de personnes et les huit obligations du
paragraphe 3. Décision de l'utilisateur du 26 octobre 2026 : « Rédige le projet » — Pixcar rédige les clauses et l'écran
d'acceptation ; **rien n'est publié avant la relecture d'un juriste**.

**État : projet.** Branche `clauses-rgpd`, jamais fusionnée ni publiée tant que le texte n'est pas relu.

## 1. Ce qui est en place

| Élément | Où | Ce qu'il fait |
|---|---|---|
| Texte | `src/partials/sous-traitance.html` | 14 articles et un modèle de mention pour les clients. Rempli à la construction avec `src/legal.json` (`editorName`, `contact`, `hostApi`). |
| Version | `src/js/shared/agreement.js` | `version` (date), `label`, `sha256` du texte, `draft`. Partagé par l'API et la page. |
| Garde-fous | `tests/unit/agreement.test.mjs`, `scripts/build.mjs` | Un texte changé sans nouvelle empreinte échoue (test et construction). La version publiée (`--pages`) refuse de se construire tant que `draft` est vrai (`PIXCAR_ALLOW_DRAFT_AGREEMENT=1` : essais seulement). La mention « Projet » du texte disparaît quand `draft` est faux. |
| Base | `db/migrations/010_pro_agreements.sql` | Une ligne par acceptation : garage, version, compte, signataire (nom déclaré au rattachement), date ; `ended_at` à la fin du rattachement. |
| API | `server/pro.mjs`, `server/rdv.mjs` | `GET` / `POST /v1/pro/garages/{id}/agreement` (`{ version, accept: true }`) ; l'accord dans le résumé du garage. Tant que la version en vigueur n'est pas acceptée : **403 `agreement_required`** sur l'ajout ou la modification d'un mécanicien, d'une absence ou indisponibilité, d'un rendez-vous saisi ou d'un créneau bloqué. Lire et supprimer restent possibles. |
| Interrupteur | `server/config.mjs` | `pro.agreementRequired` : exigé dès que `draft` est faux ; `PRO_AGREEMENT_REQUIRED=1` ou `0` pour forcer. Un projet fusionné par erreur ne bloque donc personne. |
| Fin et purge | `server/pro-repo.mjs` | Le retrait du rattachement (`pro-revoke`) clôt l'accord ; la preuve close est effacée 5 ans plus tard (purge quotidienne). Un nouveau titulaire accepte à son tour. |
| Écran | `src/js/pro/agreement.js`, `src/pro/index.html` | Fenêtre « Accord de sous-traitance des données » (texte défilant, case, « Accepter l'accord ») ; bandeau dans Gestion d'atelier tant qu'il n'est pas accepté ; rubrique dans Mon garage › Modules (« Accepté le … par … »). Un refus 403 rouvre la fenêtre et garde le formulaire en cours, pour réessayer une fois accepté. |
| Confidentialité | `src/partials/legal.html`, « Vos données » de l'Espace Pro | Citent l'accord et la conservation de sa preuve (5 ans après la fin du rattachement). |
| Auto-contrôle | `server/selfcheck.mjs` | Acceptation, une seule par version, relecture, purge des preuves de plus de 5 ans, clôture au retrait : sur Aurora DSQL au déploiement. |

Couvert par l'accord : mécaniciens, horaires, compétences, absences, affectations ; rendez-vous saisis par le garage (nom ou véhicule,
téléphone, immatriculation, durée, origine, commentaire, état de l'intervention) ; libellés des créneaux bloqués ; historique des
changements. **Pas couvert** : le compte de l'Espace Pro, la fiche publique, les prix annoncés et les demandes de rendez-vous faites
sur Pixcar par les automobilistes (décrits dans la politique de confidentialité, Pixcar y est présenté comme responsable).

## 2. Questions pour le juriste

1. **Qualité du sous-traitant.** Pixcar est édité « à titre non professionnel » par une personne physique (`src/legal.json`). Un
   garage peut-il confier ces données à un particulier ? Responsabilité personnelle, assurance, besoin d'une structure (entreprise
   individuelle, société) avant de faire accepter l'accord à de vrais garages.
2. **Garanties suffisantes** (article 28, paragraphe 1) : les mesures de l'article 6 du texte suffisent-elles, ou faut-il une annexe
   technique plus précise ?
3. **Hébergeur.** Amazon Web Services EMEA SARL (Luxembourg), données dans la région de Stockholm ; groupe américain. Faut-il
   mentionner un accès possible par des autorités hors de l'Union, et la certification de l'hébergeur au cadre de protection des
   données UE–États-Unis ? *Je ne l'ai pas vérifiée.*
4. **Forme de l'acceptation** : case cochée par le compte rattaché au garage (rattachement vérifié par SIRET et code), preuve gardée
   (version, compte, nom déclaré, date ; pas d'adresse IP). Suffisant comme « acte juridique » écrit ?
5. **Conservation de la preuve** : 5 ans après la fin du rattachement (proposition calée sur la prescription de droit commun).
6. **Délais proposés** : violation notifiée sous 48 h ; demande d'une personne transmise sous 5 jours ouvrés ; copie des données sous
   15 jours ; préavis de 30 jours pour un nouveau sous-traitant ; audit une fois par an, préavis de 30 jours, aux frais du garage.
7. **Responsabilité** : simple renvoi à l'article 82. Plafond, exclusions ?
8. **Rendez-vous pris en ligne** par les automobilistes : Pixcar reste-t-il responsable du traitement une fois la demande transmise
   au garage, ou devient-il sous-traitant pour la suite (affectation, état de l'intervention) ? L'accord les exclut aujourd'hui.
9. **Information des personnes** : le modèle de mention pour les clients suffit-il ? Faut-il un modèle pour les salariés ?
10. **Absences des mécaniciens** : la « précision » est un texte libre (risque de donnée de santé malgré l'interdiction de l'article
    13 du texte) et les absences passées sont gardées jusqu'à leur suppression. Faut-il retirer ce champ ou purger les absences après
    une durée fixe ?
11. Droit applicable et juridiction.

## 3. À vérifier ou à faire avant de publier

- **Registre des traitements** (article 30, paragraphe 2) : le texte dit que Pixcar le tient. **Il n'existe pas encore** : à créer.
- **Chiffrement au repos** d'Aurora DSQL et du coffre AWS Backup : le texte l'affirme ; à vérifier dans la console AWS.
- `src/legal.json` : `updated` (date de mise à jour de la politique) au jour de la publication.

## 4. Finaliser le texte (après la relecture)

1. Reporter le texte relu dans `src/partials/sous-traitance.html`.
2. Dans `src/js/shared/agreement.js` : `version` et `label` à la date du texte final, `sha256` (`sha256sum
   src/partials/sous-traitance.html`), **`draft: false`**.
3. `npm run -s test:unit`, `npm run -s test:server`, `node tests/run.mjs dist proaccord pro proatelier proplan procal prodash`.
4. Plus tard, tout changement de texte déjà accepté par un garage : nouvelle `version` (la page la lui redemande, l'API refuse les
   écritures d'ici là).

## 5. Mettre en ligne (chaque étape après le go de l'utilisateur)

L'ordre compte : une API qui exige l'accord avant que la page permettant de l'accepter soit en ligne bloquerait l'équipe et les
rendez-vous saisis des garages.

1. Fusionner `clauses-rgpd` dans `main` (texte final, `draft: false`), pousser.
2. **Publier le site d'abord** (`gh-pages`). Face à l'API d'avant, la page ne montre rien de l'accord (le résumé du garage n'en dit
   rien) : sans effet pour les garages.
3. **Puis déployer l'API** depuis CloudShell (docs/exploitation.md, « Déployer l'API depuis CloudShell ») : migration
   `010_pro_agreements.sql`, auto-contrôle (une vérification de plus), essai de bout en bout. À partir de là, l'API exige l'accord.
4. Vérifier avec le garage d'essai : bandeau, refus d'un rendez-vous saisi, fenêtre, acceptation, second essai réussi.

**Retour arrière** : redéployer l'API précédente (`CodeKey` et `OpsCodeKey` de la pile, valeurs données par le résumé du
déploiement) ; la table `pro_agreements` reste (l'ancien code l'ignore), et republier la version précédente du site.
