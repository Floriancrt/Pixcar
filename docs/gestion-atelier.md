# Gestion d'atelier : modes simple et avancé

Cahier des charges de l'utilisateur du 25 octobre 2026 (« PROMPT — PIXCAR : conception et développement des modes simple et avancé de
gestion d'atelier »). Ce document suit ses étapes : diagnostic (1), conception fonctionnelle (2), maquettes (3, fichiers à part), plan de
réalisation (4). L'implémentation (5) et la validation (6) se font sur la branche `gestion-atelier`, par petites étapes vérifiables.

Il s'appuie sur l'existant, décrit dans [rendez-vous.md](rendez-vous.md) (lots 1 et 2 : créneaux, demandes, mini-site) et
[calendrier-avance.md](calendrier-avance.md) (lots 3a à 3c : ressources, moteur, Planning, interventions, tableau de bord).

## 1. Diagnostic

### 1.1 Ce qui existe déjà (en service depuis le 18 au 24 octobre 2026)

**Socle technique** : page statique (JavaScript sans framework, modules ES, `src/js/pro/*.js`, feuille `src/css/pro.css`), API Node
(`server/*.mjs`) sur AWS Lambda, base Aurora DSQL (PostgreSQL et PGlite pour les tests), moteur de planification **partagé** entre la
page et l'API (`src/js/shared/plan.js` pour les ressources, `src/js/shared/rdv.js` pour les créneaux), comptes Cognito sans mot de passe.
Les règles de calcul sont donc déjà centralisées : l'agenda du garage et la réservation publique lisent le même moteur (exigence 14.3).

| Exigence du cahier des charges | État | Où |
|---|---|---|
| Deux modes, aucune perte de données au passage | **Fait**, mais le « mode » est un réglage du garage qui change le calcul des disponibilités, pas un affichage | `rdv_calendar.mode`, `…/calendar/activate`, `…/calendar/simple` |
| Calendrier Jour, Semaine, Mois, par mécanicien, par poste | **Fait, en mode avancé seulement** | écran Planning, `planning.js` |
| Vue Liste | **Absente** (l'écran Demandes liste seulement les demandes Pixcar) | |
| Plein écran, Aujourd'hui, navigation, filtres repliables avec puces, bandeau de chiffres masquable, recherche | **Fait** (plein écran dans la page ; recherche limitée à la période affichée) | Planning |
| Création rapide (clic sur une case vide, menu « Nouveau »), panneau latéral qui pousse la grille, glisser-déposer validé par l'API | **Fait, en mode avancé seulement** | Planning, `…/calendar/blocks`, `…/requests/:id/move` |
| Rendez-vous pris hors Pixcar | **Mode avancé seulement** : libellé de 40 caractères, prestations, jour, heure ; durée calculée, non modifiable | `rdv_blocks` (`job`) |
| Créneau bloqué | **Mode avancé seulement** (sur des mécaniciens ou des postes) ; en mode simple, fermetures **par journée entière** | `rdv_blocks` (`hold`), `rdv_closures` |
| Origine du rendez-vous | Pixcar, hors Pixcar, créneau bloqué ; **pas** de canal (téléphone, sur place…) | Planning |
| États d'intervention, client absent, e-mail « voiture prête », page de suivi du client | **Fait, en mode avancé seulement** (409 `simple_mode`) | `rdv_work_orders`, `work.js` |
| Mécaniciens (horaires, absences, compétences datées, prestations autorisées), postes et équipements (types, horaires, maintenances), exigences par prestation (main-d'œuvre, temps commun, immobilisation, marge, N mécaniciens, poste, outils) | **Fait** | assistant en 6 étapes, Mon garage › Ressources |
| Temps de travail, immobilisation, restitution distingués | **Fait** (dépôt, travaux, prêt, restitution) | moteur `plan.js` |
| Conflits détectés, expliqués, autres horaires proposés, jamais de déplacement automatique | **Fait** | 409 `conflict`, `shifted`, `overlap` |
| Double réservation (verrou du garage, revérification au moment du code, reprise sur conflit DSQL) | **Fait** | `lockGarage`, `withRetry` |
| Tableau de bord (capacité, équipe, postes, rendez-vous, demandes, points d'attention) | **Fait** (deux versions : mode simple, mode avancé) | `home.js` |
| Mon garage en rubriques, dont « Modules » | **Fait**, mais les modules viennent ensemble avec le mode avancé (non réglables un par un) | `dashboard.js` |
| Historique des changements, cloisonnement par garage, heure de Paris et changements d'heure | **Fait** | `rdv_history`, `ownedGarage`, `parisInstant` |

### 1.2 Les écarts qui comptent

1. **Le mode simple n'a pas d'agenda.** Un garage en mode simple voit ses demandes Pixcar dans une liste (Demandes), mais il ne peut
   ni consulter une journée, ni noter un rendez-vous pris par téléphone, ni suivre l'état d'une voiture. Or c'est le mode par défaut et
   celui de la plupart des garages visés (un ou deux mécaniciens). C'est l'écart principal : **cas 2, 12 et critères d'acceptation 1 à 6
   non remplis en mode simple.**
2. **Un rendez-vous pris par téléphone ne consomme pas la capacité en ligne en mode simple** (les blocs y sont refusés). Le risque de
   double réservation est réel pour un garage qui prend aussi des rendez-vous par téléphone.
3. **Mode d'affichage et règles de réservation sont confondus.** Passer en « mode avancé » change aujourd'hui le calcul des horaires
   proposés aux automobilistes. Le cahier des charges demande l'inverse : un affichage choisi par l'utilisateur, sans effet sur la
   réservation, et un changement des règles qui soit une action à part.
4. **Modules non réglables un par un** (écart déjà noté le 24 octobre, « à décider »).
5. **Vues avancées manquantes** : planning des mécaniciens et des équipements **en lignes** (aujourd'hui : en colonnes, vue Jour),
   suivi des interventions par état (aujourd'hui : actions dans la fiche et le tableau de bord), vue Charge et capacité dédiée.
6. **Détails manquants** : canal d'origine, durée modifiable, immatriculation et commentaire sur un rendez-vous saisi, liste, recherche
   au-delà de la période affichée, redimensionnement d'un bloc, plein écran du navigateur, états « En attente d'accord client » et
   « Contrôle final », temps réellement passé, garde contre le double clic à la création d'un bloc.

### 1.3 Risques techniques et incohérences métier

- **Aurora DSQL** : une colonne ajoutée ne peut avoir ni valeur par défaut ni contrainte, et une contrainte `CHECK` existante ne se
  modifie pas simplement (`calendrier-avance.md`, « Données »). Conséquences : nouvelles colonnes **facultatives**, validées par l'API ;
  les états d'intervention et les types de poste ne peuvent pas être étendus par la contrainte existante (`rdv_work_orders.status`,
  `rdv_resources.type`) : on ajoute une colonne de précision à côté.
- **Rôles (14.4)** : un garage n'a qu'**un** compte (index unique `pro_claims_one_owner_idx`) et les mécaniciens sont des ressources, pas
  des comptes (décision du 19 octobre). Gérant, responsable d'atelier et collaborateur supposent une gestion multi-comptes (invitations,
  droits, journal par personne) qui n'existe pas : **hors du périmètre**, à décider à part. « Adapter les droits au système existant »
  revient aujourd'hui à : le compte du garage a tous les droits.
- **Coordonnées des clients saisies par le garage** (téléphone, e-mail, immatriculation d'un rendez-vous pris par téléphone) : Pixcar les
  conserverait **pour le compte du garage** (sous-traitant au sens du RGPD, article 28). La décision du 19 octobre l'avait reportée
  (« contrat et confidentialité à revoir »). Un contrat de sous-traitance (conditions de l'Espace Pro) et le texte de confidentialité sont
  à faire relire. **Décision de l'utilisateur à prendre** (section 2.8).
- **Charge mécaniciens ≠ occupation des postes** : déjà calculées séparément ; à garder séparées dans la vue Charge.
- **Un affichage « avancé » sur un garage qui calcule par créneaux** n'a pas d'affectations à montrer : les rendez-vous y sont « À
  affecter » (cas 3), sans rien supprimer ; l'affectation à la main (sans changer le calcul en ligne) est une évolution P1.
- **Statistiques** : aucun temps réel n'est saisi aujourd'hui ; durées réelles et écarts ne peuvent pas être affichés honnêtement avant
  que les heures de début et de fin réelles soient notées (P1), et seulement avec la mention « données insuffisantes » en dessous d'un
  seuil.

## 2. Conception fonctionnelle

### 2.1 Trois réglages distincts (« un seul Pixcar, deux niveaux »)

| Réglage | Qui le choisit | Effet | Stockage |
|---|---|---|---|
| **Affichage** : Simple ou Avancé | chaque compte (aujourd'hui : le seul compte du garage) | ce que montre l'écran Gestion d'atelier ; **aucun effet** sur les données ni sur les horaires proposés | `pro_prefs.view` (nouveau) |
| **Modules** : Mécaniciens, Équipements, Suivi des interventions, Charge et capacité, Analyses | le garage | quels outils apparaissent en affichage Avancé ; un module coupé garde ses données | `rdv_calendar.modules` (nouveau) |
| **Calcul des disponibilités** : par créneaux ou par ressources | le garage, par une action explicite et contrôlée | les horaires proposés en ligne | `rdv_calendar.mode` (existant, inchangé) |

Le **calcul par créneaux** est le mode simple actuel (semaine type, capacité par créneau). Le **calcul par ressources** est le mode
avancé actuel (mécaniciens, postes, compétences). Passer de l'un à l'autre reste l'action actuelle, avec ses contrôles (aucun rendez-vous
perdu, refus tant qu'un rendez-vous ne trouve pas de place). **Revenir à l'affichage simple ne change jamais le calcul** (cas 9).

Dépendances des modules :

| Module | Demande | Si on le coupe |
|---|---|---|
| Mécaniciens | — | vue Équipe masquée ; **refusé** tant que le calcul se fait par ressources (le moteur s'en sert) : il faut d'abord revenir au calcul par créneaux, ce que l'écran explique |
| Équipements | — | vue Équipements masquée ; les exigences de poste des prestations sont **ignorées** par le moteur (le garage le confirme : ses horaires en ligne changent) |
| Suivi des interventions | — | états d'avancement simplifiés au cycle du mode simple (À venir, Arrivé, En cours, Terminé) ; l'historique reste |
| Charge et capacité | Mécaniciens ou Équipements | vue Charge masquée |
| Analyses | Suivi des interventions | écran Analyses masqué |

### 2.2 L'écran « Gestion d'atelier » (remplace « Planning », visible dans les deux calculs)

Zones, de haut en bas (le calendrier prend tout l'espace restant) :

- **A. En-tête** : « Gestion d'atelier », nom du garage, date consultée ; à droite, sélecteur **Simple | Avancé**, « + Nouveau
  rendez-vous » (orange), plein écran.
- **B. Indicateurs** (masquables, choix gardé) : *Rendez-vous du jour* · *En cours* (véhicule arrivé ou en cours) · *Terminés* ·
  *Horaires encore réservables* (calculés par l'API avec le même moteur que la réservation publique, pour la prestation la plus courte).
  En affichage Avancé : + *Charge atelier*, *Mécaniciens présents*, *Alertes*.
- **C. Barre d'outils** : ‹ › , période, Aujourd'hui, vues (Simple : **Jour · Semaine · Liste** ; Avancé : + Mois, Équipe, Équipements,
  Suivi, Charge), Filtres (avec leur nombre), recherche.
- **D. Filtres** dans un panneau latéral gauche **entièrement rétractable** : statut, origine, prestation, mécanicien (s'il y en a) ;
  puces supprimables sous la barre, « Réinitialiser les filtres ».
- **Panneau de détail** à droite (existant) : fiche, formulaires de création, de déplacement, d'annulation.

### 2.3 Affichage simple

- **Vue Jour** : une colonne (ou une par créneau qui se chevauche, s'ils sont plusieurs), blocs proportionnels à la durée, plages libres
  visibles, pause de midi hachurée ; bloc ouvert entouré.
- **Vue Semaine** : jours en colonnes, heures en lignes ; les rendez-vous simultanés côte à côte (couloirs), jamais l'un sur l'autre.
- **Vue Liste** : rendez-vous par jour, dans l'ordre ; heure, véhicule, prestation, client, état, origine ; actions rapides (état
  suivant, appeler, ouvrir). Vue par défaut sur téléphone.
- **Carte d'un rendez-vous** : `09:00 – 10:00 · Renault Clio IV` / `Vidange + filtre à huile` / icône d'origine · état. Les lignes
  dépendent de la hauteur ; tout est dans l'infobulle, le nom lu et la fiche.
- **Origine** : une seule icône, une infobulle ; on enregistre séparément le **canal** (Pixcar, Téléphone, Sur place, Autre) et la
  **méthode** (réservé en ligne par le client, saisi par le garage). Pas de couleur par origine.
- **États** (icône **et** libellé, jamais la couleur seule) : *À venir*, *Arrivé*, *En cours*, *Terminé*, *Restitué*, *Annulé*,
  *Non présenté* ; *À confirmer* pour une demande Pixcar en attente.
- **Création rapide** (panneau, < 30 s) : prestation(s), date, heure, **durée proposée d'après la prestation et modifiable**, véhicule
  (modèle ou immatriculation, l'un des deux), client (nom) ; facultatif : immatriculation, téléphone (selon la décision 2.8), canal
  (Téléphone par défaut, Sur place, Autre), commentaire interne, heure de restitution. Jamais de mécanicien ni de poste obligatoire.
  Clic sur une case vide : date et heure préremplies.
- **Modifier** : depuis la fiche (horaires, durée, état), par glisser-déposer (heure, jour) et, pour un rendez-vous saisi par le garage,
  en tirant le bas du bloc (durée). Un rendez-vous Pixcar déplacé : confirmation, e-mail « nouvel horaire » au client (règle actuelle).

### 2.4 Règles de réservation (les mêmes partout)

**Calcul par créneaux** (inchangé pour les demandes en ligne, étendu aux rendez-vous saisis par le garage) :

- Un rendez-vous saisi par le garage **prend une place** dans le premier créneau de la semaine type qui couvre son horaire (sa durée
  entière) et a encore de la place, **quelles que soient ses prestations** (la liste de prestations d'un créneau dit ce que les clients
  peuvent réserver en ligne, pas ce que le garage fait). Il réduit donc tout de suite les horaires proposés en ligne (cas 2).
- Plus de place : l'API refuse en expliquant (« Créneau Journée : 2 voitures déjà prévues de 9:00 à 10:00 ») et propose d'autres
  horaires ; le garage peut **confirmer quand même** (il sait ce qu'il fait) : le créneau est alors plein, rien n'est proposé en ligne
  sur cette plage.
- Hors de tout créneau (en dehors des heures proposées en ligne) : enregistré, sans effet sur la réservation en ligne ; la fiche le dit.
- **Créneau bloqué** : bloque tout l'atelier sur la plage (aucun horaire en ligne qui la chevauche, cas 12) ; refusé s'il chevauche un
  rendez-vous, sauf confirmation.
- **Événement informatif** (note, rappel) : ne prend aucune place (P1).
- La capacité se compte sur **toute la durée** (déjà le cas : pic de [début, fin[).

**Calcul par ressources** : inchangé (moteur `plan.js`) ; les rendez-vous saisis y sont déjà planifiés comme les demandes.

**Concurrence** : toute écriture passe par le verrou du garage puis recalcule dans la transaction (déjà en place) ; la création d'un
rendez-vous porte un identifiant fourni par la page, si bien qu'un double clic ou une reprise réseau ne crée pas de doublon.

### 2.5 Affichage avancé

- **Agenda global** : l'agenda du mode simple, avec mécanicien, poste, durée, avancement, retard, conflits, « À affecter ».
- **Équipe** (planning des mécaniciens) : une **ligne** par mécanicien, les heures de la journée en abscisse ; horaires de travail,
  pauses, absences hachurées, interventions ; charge du jour (« 5 h 30 / 7 h · 79 % ») ; glisser une intervention vers une autre ligne
  la réaffecte (contrôle de l'API, confirmation si l'heure d'un rendez-vous client change) ; filtre par compétence.
- **Équipements** : même principe, une ligne par poste ; maintenances ; un poste exclusif n'est jamais pris deux fois.
- **Suivi des interventions** : colonnes par état (À préparer → En cours → En attente → Contrôle → Terminé), ou liste ; véhicule,
  client, prestation, mécanicien, heure prévue, temps estimé et réel, motif d'attente, restitution prévue ; filtres « En retard » et
  « À traiter ».
- **Charge et capacité** : jour et semaine ; heures de travail disponibles, planifiées, restantes ; **séparément** occupation des postes ;
  interventions non affectées ; alertes de surcharge.

### 2.6 Interventions

Rendez-vous (engagement client) → intervention (travaux, `rdv_work_orders`, une par rendez-vous) → étapes (groupes de prestations sur
un même type de poste, déjà calculés par le moteur) → affectations (`rdv_assignments`). États avancés : *Planifiée*, *Arrivé*, *En
cours*, *En attente de pièces*, *En attente d'accord client* (nouveau), *Suspendue*, *Contrôle final* (nouveau), *Terminée*,
*Restituée* ; *À planifier* = sans affectation (calculé, pas stocké). Une intervention terminée n'est pas une voiture restituée (déjà
le cas). Attente de pièces : le mécanicien n'est pas retenu au-delà de ses segments prévus ; le reste du travail se replanifie quand
les pièces arrivent (P1).

### 2.7 Hypothèses retenues

- Un seul compte par garage : « préférences de l'utilisateur » = préférences du compte.
- Pas de mécaniciens-utilisateurs ni de rôles (hors périmètre).
- Le calcul par créneaux reste le défaut ; aucun garage n'est basculé.
- Pas d'import d'agenda externe (icône « importé » non affichée tant que la fonction n'existe pas).
- Pas de stock, facturation, comptabilité.

### 2.8 Décisions de l'utilisateur

1. **Coordonnées d'un client saisi par le garage** (25 octobre 2026, « Nom, véhicule, plaque, tél. ») : nom, véhicule (modèle),
   immatriculation et téléphone, tous facultatifs sauf le nom ou le véhicule ; **pas d'e-mail** (Pixcar n'écrit pas à ces clients).
   Conservés pour le compte du garage (Pixcar sous-traitant, article 28 du RGPD) et effacés 30 jours après le rendez-vous, comme le
   libellé. **Avant la mise en ligne** : contrat de sous-traitance dans les conditions de l'Espace Pro et texte de confidentialité, relus
   par un juriste.

## 3. Maquettes

Les douze écrans demandés sont **rendus dans le vrai Espace Pro** (branche `gestion-atelier`), pas dessinés à part : l'écran Gestion
d'atelier existait déjà (Planning, validé le 24 octobre 2026) et les vues nouvelles s'appuient sur des données que l'API fournit déjà ;
une maquette statique aurait été refaite une seconde fois en code. Données de démonstration réalistes, sur la vraie API (PGlite) :
`node tests/demo-atelier.js` construit le garage (« Garage des Pyrénées », trois mécaniciens, six postes, une semaine de rendez-vous Pixcar
et pris par téléphone, interventions en cours, absence, maintenance, créneau bloqué ; horloges fixées au mardi 27 octobre 2026 à 10:40)
et écrit les captures dans `tests/.out/demo-atelier/shots/` (envoyées à l'utilisateur le 25 octobre 2026, non versionnées) :

| N° | Écran | Capture |
|---|---|---|
| 1 | Mode simple — Semaine | `01-simple-semaine.png` |
| 2 | Mode simple — Jour | `02-simple-jour.png` |
| 3 | Mode simple — Création de rendez-vous | `03-simple-creation.png` |
| 4 | Mode simple — Filtres (ouverts, puis rétractés avec un filtre actif) | `04-simple-filtres.png`, `04b-simple-filtres-replies.png` |
| 5 | Mode simple — Plein écran | `05-simple-plein-ecran.png` (et la liste : `05b-simple-liste.png`) |
| 6 | Mode avancé — Agenda global | `06-avance-agenda.png` |
| 7 | Mode avancé — Planning mécaniciens | `07-avance-equipe.png` (semaine : `07b-avance-equipe-semaine.png`) |
| 8 | Mode avancé — Planning équipements | `08-avance-equipements.png` |
| 9 | Mode avancé — Suivi des interventions | `09-avance-suivi.png` |
| 10 | Mode avancé — Charge et capacité | `10-avance-charge.png` (semaine : `10b-avance-charge-semaine.png`) |
| 11 | Paramètres — Modules | `11-parametres-modules.png` |
| 12 | Fiche détaillée d'une intervention | `12-fiche-intervention.png` |
| — | Téléphone (liste) | `13-telephone-liste.png` |

À ce stade, l'écran n'est complet qu'avec l'API du P0 (section 4) : en calcul par créneaux, la saisie d'un rendez-vous, les états et le
déplacement d'une demande sont encore refusés par l'API en service (409 `simple_mode`), et les nouveaux champs (canal, téléphone,
véhicule, immatriculation, durée, restitution, commentaire, modules) ne sont pas encore enregistrés.

## 4. Plan de réalisation

### P0 — affichage simple opérationnel, dans les deux calculs

| Étape | Contenu | Vérification |
|---|---|---|
| 0.1 Données | migration `009_atelier.sql` : `rdv_blocks` + `slot_id`, `channel`, `minutes`, `car`, `plate`, `phone` (selon 2.8), `note`, `cancelled_at` ; `pro_prefs` + `view` (colonnes facultatives, validées par l'API) | migrations sur PGlite et PostgreSQL ; `selfcheck` |
| 0.2 Moteur des créneaux | `freeTimes` compte les rendez-vous saisis (par leur créneau) et les créneaux bloqués (tout l'atelier) ; `placeInSlot` (créneau qui a de la place, ou cause du refus) | tests unitaires (capacité sur toute la durée, chevauchements, créneau bloqué, hors créneau) |
| 0.3 API | blocs autorisés dans le calcul par créneaux ; déplacement d'une demande en calcul par créneaux (capacité, e-mail) ; états d'intervention dans les deux calculs ; `view` dans les préférences ; agenda : canal, durée, horaires réservables du jour ; identifiant de création (doublons) | tests serveur ; OpenAPI |
| 0.4 Écran | « Gestion d'atelier » visible dans les deux calculs ; sélecteur Simple / Avancé ; vue Liste ; indicateurs du mode simple ; carte avec origine et état ; création rapide simplifiée ; états dans la fiche et la liste ; plein écran du navigateur ; « Réinitialiser les filtres » | test navigateur (bout en bout sur la vraie API), axe, contrastes, captures ordinateur, tablette, téléphone |
| 0.5 Documentation | `rendez-vous.md`, `calendrier-avance.md`, confidentialité (selon 2.8), `exploitation.md` | relecture |

Mise en ligne : **API avant le site** (la nouvelle page appelle des routes que l'ancienne API refuse ; l'ancienne page fonctionne avec la
nouvelle API). Chaque étape (fusion dans `main`, déploiement, publication) attend le go de l'utilisateur.

### P1 — ressources dans l'affichage avancé

Modules réglables un par un (dépendances de 2.1) ; vues Équipe et Équipements en lignes ; Suivi des interventions par état ; Charge et
capacité ; états « En attente d'accord client » et « Contrôle final » (colonne de précision à côté de l'état, la contrainte ne change
pas) ; heures réelles de début et de fin ; affectation à la main en calcul par créneaux (« À affecter ») ; recherche au-delà de la
période (route dédiée, 90 jours avant et après) ; redimensionnement ; types de poste carrosserie, peinture, vitrage (colonne de
précision) ; événements informatifs ; replanification après attente de pièces.

### P2 — pilotage

Analyses (écarts estimé / réel, taux d'occupation, rendez-vous honorés, répartition par canal) avec seuil « données insuffisantes » ;
alertes de retard avec tâches suivantes impactées ; suggestions de réorganisation, toujours validées par le garage. Comptes et rôles
(gérant, responsable, collaborateur) : projet à part.

### Tests prévus

Règles de disponibilité (unitaires), création et modification, conflits, transitions d'état, passage entre affichages (aucune donnée
touchée), affectations, concurrence (deux réservations sur la dernière place, double clic), cloisonnement par garage (droits), formats
d'écran (1280, 900, 390 px), non-régression (suites existantes : `npm test`, `npm run test:dist`, serveur, unitaires).

## 5. Implémentation (P0, branche `gestion-atelier`, 25 et 26 octobre 2026)

Livré : le P0 entier, plus les vues de l'affichage avancé du P1 qui existaient déjà côté écran (Équipe, Équipements, Suivi, Charge,
modules réglables). Restent du P1 : les états de précision (accord client, contrôle final), les heures réelles, l'affectation à la main
en calcul par créneaux, la recherche hors période, le redimensionnement, les types de poste supplémentaires, la replanification.

### 5.1 Données (`db/migrations/009_atelier.sql`)

Neuf colonnes ajoutées, nullables, sans défaut ni contrainte (seule forme qu'accepte `ALTER TABLE … ADD COLUMN` sur Aurora DSQL),
`IF NOT EXISTS` pour qu'une migration interrompue se relance. Contrôles dans l'API (`parseBlock`, `parsePrefs`, `parseModules`).

| Table | Colonnes | Écart avec le plan 0.1 |
|---|---|---|
| `rdv_blocks` | `slot_id`, `channel`, `minutes`, `car`, `plate`, `phone`, `note` | pas de `cancelled_at` : un rendez-vous saisi annulé est supprimé, comme avant (P1 si le garage veut garder une trace) |
| `rdv_settings` | `modules` (jsonb) | **ajouté** : les modules sont un réglage du garage ; les mettre dans `rdv_calendar` aurait créé sa ligne, qui signifie « assistant du calcul par ressources ouvert » |
| `pro_prefs` | `view` | — |

`rdv_blocks.label` reste le nom du client d'un rendez-vous saisi (vide si seul le véhicule est connu) ; l'agenda renvoie `label` (le
titre : le client, sinon le véhicule) et `client` (tel que saisi). Le téléphone est gardé au format `+33…` (même analyseur que les fiches
des garages), affiché `06 12 34 56 78`. Purge : nom, téléphone, véhicule, immatriculation et commentaire effacés 30 jours après le jour,
la ligne après 24 mois (comme avant pour le libellé).

### 5.2 Règles retenues

- **Place d'un rendez-vous saisi, calcul par créneaux** (`placeInSlot`, `src/js/shared/rdv.js`) : le créneau du jour qui contient son
  heure de début ; de préférence celui qui propose ses prestations et où toute la durée tient ; il compte sur `[début, début + durée[`
  (à l'heure) ou comme une voiture du jour (dépôt). Durée : celle saisie, sinon le temps moyen de Mon garage, sinon 60 min. Plein : 409
  `full` avec la cause et trois autres heures du jour ; enregistré quand même après confirmation (le garage reste maître). Hors de tout
  créneau : enregistré sans réduire aucun horaire en ligne.
- **Créneau bloqué sans mécanicien ni poste = tout l'atelier**, dans les deux calculs : par créneaux, aucun horaire en ligne pendant la
  plage (les rendez-vous déjà là restent, après confirmation : 409 `overlap`) ; par ressources, il occupe chaque mécanicien et chaque
  poste, y compris ceux ajoutés plus tard (étendu à la lecture, rien n'est écrit dans `rdv_assignments`).
- **Modification** : les champs du client absents du corps sont gardés ; un glisser-déposer n'envoie que le jour, l'heure et
  l'affectation. Une restitution choisie garde son écart avec l'heure de dépôt quand le rendez-vous bouge.
- **Doublons** : la création porte un identifiant choisi par l'écran (`ref`), qui devient celui du bloc ; rejouée, elle renvoie le même
  bloc (200, `replay: true`). Deux créations simultanées sur la dernière place passent l'une après l'autre (verrou du garage).
- **Déplacement d'une demande Pixcar en calcul par créneaux** : compté dans le créneau de la nouvelle heure ; la confirmation, déjà
  demandée parce que le client est prévenu, dit aussi si le créneau est plein.
- **Bascule du calcul** : vers les ressources, les rendez-vous saisis sans affectation sont placés comme les demandes (l'aperçu les
  montre) et les modules Mécaniciens et Équipements reviennent ; vers les créneaux, chaque rendez-vous saisi à venir est rattaché au
  créneau de son heure (même plein).
- **Affichage** : préférence du compte (`pro_prefs.view`), le navigateur n'en garde qu'une copie de secours ; à la première visite,
  celui qui va avec le calcul des disponibilités.

### 5.3 Mise en ligne : deux temps obligatoires

La nouvelle API lit les colonnes de 009 dans presque toutes les routes de rendez-vous, réservation publique comprise (`bookings`,
`bundle`). Elle ne doit donc jamais servir avant la migration. Ordre : (1) paquet contenant la migration et l'ancien code, `migrate`,
`selfcheck` ; (2) paquet du nouveau code ; (3) site. L'ancien code ignore les nouvelles colonnes (compatible). Détail dans
`exploitation.md` le jour du déploiement ; rien n'est déployé sans le go de l'utilisateur. **Fait le 26 octobre 2026** autrement, sans paquet
intermédiaire : depuis CloudShell, la fonction d'opérations passe seule au nouveau code, migre et s'auto-contrôle avant que l'API ne
change (paramètre `OpsCodeKey`) ; puis le site (`exploitation.md`, 10.17).

### 5.4 Textes à faire relire

La politique de confidentialité (`src/partials/legal.html`) et la note de l'Espace Pro disent maintenant que Pixcar agit comme
sous-traitant (article 28 du RGPD) pour les clients que le garage saisit. Les conditions de l'Espace Pro doivent contenir les clauses de
sous-traitance (décision 2.8) : **à rédiger et faire relire par un juriste avant la mise en ligne** ; la date de mise à jour de la
politique (`legal.json`) est à changer à la publication.

## 6. Validation (P0)

| Niveau | Fichier | Ce qui est vérifié |
|---|---|---|
| Unitaires | `tests/unit/atelier.test.mjs` | plages bloquées dans `freeTimes`, `placeInSlot` (préférences, plein, hors créneau, dépôt, demande expirée, exclusion), `parseBlock` (champs gardés absents, téléphone, immatriculation, tout l'atelier, refus des affectations), modules et préférence |
| Serveur (PGlite) | `server/test/atelier.test.mjs` | place prise pour toute la durée, rejeu, plein puis confirmé, glisser sans perte, blocage de tout l'atelier, chevauchement confirmé, validations, effacement à 30 jours, états, déplacement d'une demande (plein, e-mail), concurrence, modules, bascules dans les deux sens |
| Contrat | `server/test/openapi.test.mjs` | nouvelles réponses et formes (201, 200 rejeu, 409 `full` et `overlap`, 422, agenda `engine` / `slots` / `free`, modules, `view`) |
| Base réelle | `server/selfcheck.mjs` | colonnes de 009, `UNION ALL` et `NOT EXISTS` de `bookings`, `jsonb` des modules, `view` — **à lancer sur Aurora DSQL au déploiement** |
| Navigateur | `tests/pro-atelier.js` | affichage simple de bout en bout (création au clavier, place prise en ligne, plein, blocages, fiche, client sur place et avancement, liste, affichage gardé sur le compte, module coupé, téléphone, axe) |
| Navigateur | `tests/pro-planning.js` | l'affichage avancé (ex-Planning) adapté : menu, origines, filtres en panneau, espaces Équipe et Équipements |

Résultat du 26 octobre 2026 : tout passe (unitaires 273/273, serveur 374/374, `npm test` 35 suites, `npm run test:dist` 39 suites,
`proatelier` 45/45) ; détail dans `docs/tests.md`. Reste le `selfcheck` sur Aurora DSQL, au déploiement.
