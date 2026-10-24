# Calendrier avancé (Espace Pro)

Le **mode simple** est celui du lot 2 ([rendez-vous.md](rendez-vous.md)) : une semaine type en créneaux, chacun avec sa capacité. Le
**mode avancé** calcule les horaires proposés à partir des **ressources réelles** de l'atelier : mécaniciens (horaires, absences,
compétences, prestations autorisées), postes et équipements (pont, banc, station…), et ce que demande chaque prestation. Le garage choisit
son mode dans Disponibilités ; passer de l'un à l'autre ne perd rien.

Découpage : **lot 3a** (ce document : modèle, moteur, API, assistant, réservation en mode avancé), lot 3b (calendrier multi-vues,
glisser-déposer, blocs internes : section « Lot 3b » plus bas), lot 3c (suivi des interventions, tableau de bord : section « Lot 3c »). Plus tard : stock, statistiques avancées, comptes mécaniciens.

## Décisions (validées par l'utilisateur le 19 octobre 2026)

| Sujet | Décision |
|---|---|
| Rendez-vous pris hors Pixcar | v1 (lot 3b) : **blocs internes** sans coordonnées obligatoires (libellé de 40 caractères), conservés comme les demandes. Plus tard : import de clients venus d'un autre outil (Pixcar devient alors sous-traitant du garage : contrat et confidentialité à revoir). |
| Confirmation automatique | Mode avancé seulement, **par prestation**, désactivée par défaut, impossible quand les pièces doivent être vérifiées. Une demande mêlant prestations automatiques et manuelles est manuelle. |
| Type de véhicule | Demandé à l'automobiliste (citadine, compacte, berline, SUV, utilitaire) **seulement** si une prestation demandée a des durées par type. |
| Déplacer un rendez-vous | Autre mécanicien ou autre poste à la même heure : sans prévenir le client. Autre heure : confirmation du garage, e-mail au client avec le nouveau fichier d'agenda et la possibilité d'annuler. |
| Bascule de mode | Vers l'avancé : les rendez-vous à venir sont affectés automatiquement ; ceux qui n'entrent pas sont listés et l'activation attend qu'ils soient placés à la main (ou annulés). Vers le simple : chaque rendez-vous à venir est rattaché à un créneau compatible ; même règle. Rien n'est déplacé ni supprimé. |
| Pause pendant une intervention | La main-d'œuvre s'interrompt (pause, fermeture de midi) et reprend ; le véhicule reste sur son poste. |
| Mécaniciens | Des ressources, pas des comptes : un seul compte par garage (inchangé). |
| Voiture prête (lot 3c) | Au passage d'un rendez-vous Pixcar à « Prête », une case « Prévenir le client par e-mail » est **cochée par défaut** (le garage peut la décocher) ; la page de suivi du client montre l'avancement. Décision de l'utilisateur du 19 octobre 2026. |
| Tableau de bord (lot 3c) | Inspiré de la maquette de l'utilisateur du 19 octobre 2026 ; raccourcis personnalisables. |

## Données (migration `006_calendar.sql`)

Mêmes règles que les migrations précédentes (PostgreSQL, PGlite, Aurora DSQL : pas de clé étrangère, une contrainte CHECK par colonne).
**Aucune table existante n'est modifiée** : sur DSQL, `ALTER TABLE … ADD COLUMN` n'accepte ni défaut ni contrainte, et changer un CHECK
demande une validation asynchrone que l'outil de migration n'attend pas (documentation AWS lue le 18 octobre 2026).

| Concept demandé | Table | Remarque |
|---|---|---|
| Garages | `garage_contacts`, `pro_profiles` (existantes) | |
| GarageCalendarSettings | `rdv_calendar` | mode, étape de l'assistant, accueil du véhicule, marge de restitution, part de la capacité ouverte en ligne, rendez-vous en ligne par jour, affectation automatique. Délai minimum, horizon, pas des horaires et jours fériés restent dans `rdv_settings`. |
| Employees, EmployeeSchedules | `rdv_staff` | horaires hebdomadaires dans la fiche (même format que « Mon garage » ; vide = ceux du garage). Les pauses sont les coupures entre deux plages. Les exceptions sont des absences. |
| Skills, EmployeeSkills | `rdv_skills`, `rdv_staff_skills` | compétences et habilitations du garage ; date de fin de validité par mécanicien (d'où la table de liaison). |
| Workstations, ressources exclusives | `rdv_resources` | postes et équipements dans une seule table : le moteur les traite de la même façon. Chacun est exclusif (deux places = deux ressources). |
| Services | catalogue `src/js/shared/services.js` et `pro_services` (existants) | nom et catégorie viennent du catalogue. |
| ServiceRequirements | `rdv_service_reqs` | par garage et par prestation. |
| Unavailabilities | `rdv_unavail` | absences des mécaniciens, maintenance et pannes des postes (à l'heure près). Les fermetures du garage restent dans `rdv_closures`. |
| Appointments | `rdv_requests` (existante) | `slot_id` = `00000000-0000-0000-0000-000000000000` pour une demande prise en mode avancé. `starts_at` = heure de dépôt ; `ends_at` = restitution prévue ; `minutes` = main-d'œuvre totale. |
| ResourceBookings | `rdv_assignments` | une ligne par mécanicien et par segment de main-d'œuvre, une par poste (occupation), une par équipement. `fixed` : choisi à la main (jamais recalculé). |
| WorkOrders | `rdv_work_orders` | une par rendez-vous en mode avancé : type de véhicule, début et fin des travaux, véhicule prêt, restitution, durées. Les statuts d'atelier sont prévus dans la table ; leurs transitions arrivent au lot 3c. |
| Historique | `rdv_history` | changements importants (mode, fiches, absences, déplacements, affectations), sans donnée de client ; effacé après 12 mois. |

Isolation : chaque ligne porte `garage_id` ; chaque route vérifie que le garage est rattaché au compte connecté (`ownedGarage`) et que
les identifiants reçus (mécanicien, poste, compétence, demande) appartiennent à ce garage.

## Règles de planification (`src/js/shared/plan.js`)

**Les quatre temps d'une intervention.** L'heure de **dépôt** (celle du rendez-vous) n'est pas le **début des travaux** :

- à l'heure : début des travaux = dépôt + accueil du véhicule (réglage, 10 min par défaut) ; le début doit tomber pile quand tout est libre ;
- en dépôt (prestation marquée « le client laisse sa voiture ») : fenêtre d'arrivée d'une heure au début de chaque plage d'ouverture ; les
  travaux commencent au plus tôt à la fin de la fenêtre, au premier moment où tout est libre, et doivent finir le jour même.

Puis la **main-d'œuvre** (temps des mécaniciens), l'**immobilisation** du poste (main-d'œuvre + temps passif : vidange qui s'écoule,
séchage…), la **marge de sécurité** (réservée sur le mécanicien et le poste après la fin) et la **restitution prévue** = véhicule prêt +
marge de restitution (réglage, 15 min par défaut), au plus tard à la fermeture.

**Plusieurs prestations.** Le **temps commun** d'une prestation (accueil sur le pont, levage, démontage des roues…) n'est compté qu'une
fois : dans un même groupe, main-d'œuvre = somme des main-d'œuvre − somme des temps communs + le plus grand d'entre eux. Les prestations
qui peuvent se faire sur le même type de poste forment un groupe (une étape) ; une prestation sans poste rejoint le premier groupe. Les
étapes se suivent (le véhicule change de poste). Prestation « par pneu » ou « par roue » : temps commun + (main-d'œuvre − temps commun)
× quantité.

**Un horaire n'est proposé que si tout est libre en même temps sur toute la durée** : N mécaniciens qui ont les compétences (habilitation
valable ce jour-là), le droit de faire ces prestations, qui travaillent, ne sont ni absents ni pris ; un poste d'un type compatible,
disponible, ni en maintenance ni occupé pendant toute l'immobilisation ; chaque équipement demandé pendant la main-d'œuvre. La
main-d'œuvre ne se fait que pendant les heures d'ouverture du garage, de travail des mécaniciens et d'utilisation du poste ; elle
s'interrompt à leurs coupures (pause de midi) mais jamais pour un autre travail.

Exemple (repris dans les tests) : plaquettes 1 h 30, mécanicien libre à 9:00, seul pont compatible occupé jusqu'à 10:00 : premier horaire
proposé 10:00 (avec un accueil de 0 min).

**Règles de réservation en ligne** (pas pour un déplacement fait par le garage) : délai minimum et heure limite de réponse (lot 2),
délai de commande des pièces si la prestation le demande, part de la capacité ouverte en ligne (minutes de main-d'œuvre des mécaniciens
présents ce jour-là), nombre de rendez-vous en ligne par jour.

**Concurrence.** La prise d'horaire se fait dans une transaction, après le verrou du garage (`lockGarage`) : le moteur relit les
affectations dans la transaction, recalcule, écrit. Deux clients sur la dernière ressource : le second reçoit « horaire déjà pris » avec
les horaires encore libres. Sur DSQL, le conflit est rejoué (`withRetry`).

**Jamais de déplacement automatique.** Une absence, une maintenance, un mécanicien désactivé ou un poste indisponible n'efface et ne
déplace aucune affectation : l'API renvoie les rendez-vous concernés (conflits) pour que le garage décide.

**Travaux qui attendraient : le garage confirme.** Un rendez-vous pris hors Pixcar se place à l'heure du dépôt. Si le mécanicien (ou le
poste) est pris à cette heure-là, le moteur trouve le premier moment libre après le dépôt, mais l'API ne l'enregistre pas d'elle-même :
409 `shifted` avec la cause (« Paul : déjà occupé de 9:00 à 9:45. »), les horaires des travaux et de la restitution, et des heures de
dépôt sans attente ; le formulaire les affiche et le bouton devient « Confirmer ces horaires » (renvoi avec `confirm: true`). Une
modification qui garde l'heure de dépôt (libellé, prestation) ne redemande pas. Ajouté le 19 octobre 2026 sur signalement de
l'utilisateur : un rendez-vous saisi à 10:00 pendant que l'unique mécanicien était pris s'enregistrait sans rien dire (travaux décalés à
10:45) et s'affichait à côté de l'autre dans la vue Semaine, comme un double rendez-vous. Le déplacement d'une demande client, lui,
reste refusé si les travaux ne peuvent pas commencer à l'heure choisie (conflit et autres horaires), comme avant.

**Pas deux absences au même moment.** Une absence (ou une indisponibilité de poste) qui chevauche une autre déjà saisie pour le même
mécanicien (ou le même poste) est refusée (409 `overlap`) : le message nomme la période existante, à modifier ou retirer d'abord. Bout
à bout, ou pour un autre mécanicien ou poste, elle passe. Ajouté le 19 octobre 2026 sur signalement de l'utilisateur : une seconde
absence identique était acceptée et se dessinait exactement sur la première dans le Planning, sans aucun avertissement.

**Heure de Paris.** Les calculs se font en minutes de la journée (heure murale de Paris) puis sont convertis en instants
(`parisInstant`) : les changements d'heure sont respectés.

## API (`/v1/pro/garages/:id/rdv/calendar`, compte connecté, garage rattaché)

| Route | Rôle |
|---|---|
| `GET …/calendar` | tout l'état : mode, réglages, mécaniciens (compétences, absences à venir), compétences, postes (indisponibilités à venir), exigences des prestations faites, contrôles avant activation |
| `POST …/calendar/start` | ouvre l'assistant : réglages, compétences proposées et exigences par défaut (si absentes) |
| `PUT …/calendar/settings` | réglages et étape de l'assistant |
| `POST`, `PUT`, `DELETE …/calendar/staff[/:staff]` | mécaniciens |
| `POST`, `PUT`, `DELETE …/calendar/skills[/:skill]` | compétences et habilitations |
| `POST`, `PUT`, `DELETE …/calendar/resources[/:res]` | postes et équipements |
| `PUT …/calendar/services/:service` | exigences d'une prestation |
| `POST`, `DELETE …/calendar/unavail[/:id]` | absences et maintenances (renvoie les rendez-vous en conflit) |
| `POST …/calendar/check` | contrôles et affectation proposée des rendez-vous à venir, sans rien écrire |
| `POST …/calendar/activate` | passe en mode avancé (affectations écrites ; refusé tant qu'un rendez-vous ne trouve pas de place) |
| `POST …/calendar/simple` | revient au mode simple (rattachement aux créneaux ; même règle) |
| `GET …/calendar/agenda?from=&to=` | rendez-vous et affectations d'une période (calendrier du lot 3b) |
| `POST …/requests/:req/move` | déplace ou réaffecte : contrôle des conflits, cause expliquée et autres horaires proposés |

Côté automobiliste, `GET /v1/rdv/garages/:id/times` accepte `vehicle=` et répond `needVehicle: true` (avec la liste des types) quand
il le faut ; chaque horaire du mode avancé porte `end` (restitution prévue) et la réponse `auto: true` quand la confirmation est immédiate.

## Lot 3b : planning, glisser-déposer, blocs internes

Choix faits au début du lot (19 octobre 2026), dans le cadre des décisions ci-dessus ; à revoir sur retour de l'utilisateur.

**Écran « Planning »** (menu de l'Espace Pro, visible en mode avancé ; sur téléphone il prend la place de « Créneaux », qui passe sous
« Plus »). Cinq vues, un seul composant de grille horaire (blocs proportionnels à la durée) sauf le mois :

| Vue | Colonnes | Contenu |
|---|---|---|
| Jour | une par mécanicien (ou par poste, au choix) | main-d'œuvre de chaque mécanicien ; occupation de chaque poste |
| Semaine | une par jour ouvert | tous les rendez-vous et blocs, côte à côte s'ils se chevauchent (dépôt → restitution) |
| Mois | grille de 6 semaines | par jour : nombre de rendez-vous et les trois premiers |
| Par mécanicien | une par jour de la semaine | la main-d'œuvre du mécanicien choisi |
| Par poste | une par jour de la semaine | l'occupation du poste choisi |

Chaque bloc montre l'heure et la durée, la confirmation, la prestation, la voiture, le client avec le mécanicien ou le poste, et la
provenance (détail plus bas : « Améliorations du 19 octobre 2026 »). Filtres : mécanicien, poste, prestation, provenance, confirmation.

**Interactions.** Un clic ouvre la fiche (client ou libellé, voiture, prestations, dépôt, travaux, restitution, affectations ; actions :
déplacer, changer de mécanicien ou de poste, appeler, annuler). Glisser-déposer (souris, doigt ; pas de 15 min) : vers une autre heure,
un autre jour, un autre mécanicien ou un autre poste. Avant d'enregistrer, l'API contrôle tout (règles du lot 3a) : en cas de conflit,
la cause et trois horaires possibles ; un changement d'heure d'un rendez-vous client demande la confirmation du garage (le client est
prévenu par e-mail). La fiche offre le même déplacement au clavier (jour, heure, mécanicien, poste). Clic sur une case vide ou
« Nouveau » : création rapide.

**Blocs internes** (table `rdv_blocks`, migration `007_calendar_blocks.sql`) :

- **rendez-vous pris hors Pixcar** (téléphone, comptoir) : libellé de 40 caractères au plus, sans coordonnées obligatoires ; prestations
  (pour la durée et les ressources), type de véhicule si une prestation en dépend, jour et heure, mécanicien ou poste au choix. Planifié
  comme une demande (même moteur, mêmes contrôles) mais sans les règles de la réservation en ligne (délai minimum, heure limite, part de
  capacité, rendez-vous par jour, pièces) ; aucun e-mail ;
- **créneau bloqué** (réunion, livraison, essai…) : libellé, jour, de… à…, un ou plusieurs mécaniciens ou postes. Refusé s'il chevauche
  un rendez-vous ou un autre bloc de ces ressources (la cause est donnée) ; pour une absence ou une maintenance, il y a les fiches.

Ils occupent leurs ressources comme les rendez-vous (`rdv_assignments.block_id`) et se déplacent de la même façon. Au retour au mode
simple, ils restent mais ne comptent plus (ce sont les créneaux qui décident) ; ils comptent de nouveau à la réactivation, qui signale
les rendez-vous sans place comme d'habitude. Conservation comme
les demandes : le libellé (qui peut contenir un nom) est effacé 30 jours après le jour du bloc, la ligne 24 mois après ; l'historique
note l'ajout, le déplacement ou la suppression d'un bloc sans son libellé.

**Ce qui a été tranché en le construisant** (`src/js/pro/planning.js`, test `tests/pro-planning.js`) :

- **Glisser-déposer, selon la vue** : en Semaine, seuls le jour et l'heure changent et le moteur rechoisit mécanicien et poste ; vers
  la colonne d'un mécanicien (Jour par mécanicien, Par mécanicien), ce mécanicien est imposé (il remplace celui du bloc glissé) ; vers
  la colonne d'un poste, ce poste est imposé. Un créneau bloqué garde ses autres mécaniciens et postes. Au doigt, le glisser commence
  après un appui long (350 ms) pour laisser la page défiler ; Échap l'abandonne. Le clic qui suit un glisser n'ouvre pas la fiche.
- **Après un glisser**, tout passe par l'API : succès → planning rechargé et annonce ; confirmation demandée (rendez-vous client à une
  autre heure) ou conflit → la fiche s'ouvre sur le formulaire de déplacement, pré-rempli, avec la cause et les autres horaires.
- **Fiche** : une demande à confirmer renvoie à « Demandes » pour y répondre ; un rendez-vous confirmé s'annule depuis la fiche (motif
  transmis au client) ; un bloc se modifie ou se supprime (second clic pour confirmer). Rien ne se déplace dans le passé.
- **Création rapide** : clic sur une case vide (jour, heure au quart d'heure, mécanicien ou poste de la colonne) ou « Nouveau » (jour
  affiché, 9:00 ou le prochain quart d'heure aujourd'hui). Rendez-vous hors Pixcar par défaut.
- **Écran** : 1 minute = 1,5 pixel sur ordinateur (1 sur téléphone), de la première à la dernière heure d'ouverture de la période ; heures fermées grisées, absences et
  maintenances hachurées en rouge avec leur libellé ; blocs qui se chevauchent côte à côte. Semaine par défaut sur ordinateur, Jour sur
  téléphone, filtres repliés sur téléphone ; la grille défile dans son cadre, jamais la page. Le menu ne montre « Planning » qu'en mode
  avancé (`rdv.mode` dans `GET /v1/pro/garages/{id}`).
- **Données** : l'agenda donne aussi le téléphone du client (pour « Appeler » depuis la fiche), comme « Demandes ».

**Améliorations du 19 octobre 2026** (retours de l'utilisateur après la mise en ligne : tableau de priorités, maquettes d'une vue
d'ensemble et d'un bloc enrichi, vidéo de la barre latérale). Tout est dans la page (`src/js/pro/planning.js`, `src/js/pro/dashboard.js`,
`src/pro/index.html`, `src/css/pro.css`) : aucune route ni donnée nouvelle, l'API du lot 3b suffit.

- **Barre latérale de l'Espace Pro** (ordinateur, 900 px et plus) : fixée tout à gauche, sur toute la hauteur (noire, le logo en
  haut ; identité du 24 octobre 2026, `docs/brand/README.md`) ; le bandeau du compte commence à sa droite et le contenu prend le
  reste de la largeur. « Replier le menu » la réduit aux icônes (le libellé reste lu par les lecteurs d'écran et
  s'affiche en infobulle) ; le choix est gardé dans ce navigateur (`localStorage`, clé `pixcar-pro-rail`). Planning a sa propre icône,
  distincte de Disponibilités. Téléphone : la barre du bas ne change pas (remplacée le 24 octobre 2026 par le rail d'icônes de 64 px à
  gauche de la maquette, voir `docs/brand/README.md`).
- **Vue d'ensemble** en haut du Planning, comptée sur la période affichée (jour, semaine, mois), sans les filtres : **Rendez-vous**
  (nombre, dont à confirmer), **Charge atelier** (heures de main-d'œuvre planifiées / heures disponibles des mécaniciens, en % avec une
  jauge), **Mécaniciens** (présents / total en vue Jour, sinon absences sur la période), **Alertes** (conflits et demandes à confirmer
  dont l'heure limite tombe dans les 24 heures). Les cartes Rendez-vous et Alertes filtrent le planning d'un clic.
- **Charge** : heures disponibles d'un mécanicien = heures d'ouverture ∩ ses horaires, moins ses absences (comme le moteur) ; d'un poste,
  de même avec ses maintenances. En Semaine, chaque jour affiche « planifié / disponible · n rdv » et une jauge ; en Jour, chaque
  colonne (mécanicien ou poste) ; en Par mécanicien et Par poste, chaque jour (avec le nombre de conflits) et le total de la semaine à
  côté du choix ; en Mois, le pourcentage de chaque jour.
- **Créneaux** : libre (fond blanc), pas proposé en ligne (pointillé : réservation fermée, avant le délai minimum, au-delà de
  l'horizon), fermé ou hors horaires (hachures grises), absence ou maintenance (hachures rouges avec le motif), passé (gris léger).
- **Trois informations séparées** : la **confirmation** (pastille et fond du bloc : à confirmer en pointillé ambre, confirmé en vert),
  la **provenance** (étiquette : Pixcar, Hors Pixcar, Créneau bloqué ; et l'icône de la ligne client : globe, téléphone, cadenas) et
  l'**alerte** (« En conflit » : contour et pastille rouges). L'état de l'intervention (`work.status` : prévue, voiture reçue, en cours…)
  est dans la fiche ; il reste « Prévue » tant que le lot 3c ne permet pas de le changer.
- **Bloc enrichi** : heure et durée **du travail** (vue Semaine comprise : du début à la fin de la main-d'œuvre des mécaniciens ce
  jour-là, si bien qu'avec un seul mécanicien deux rendez-vous ne se superposent pas ; le séjour de la voiture, dépôt et restitution, est
  dans l'infobulle, le nom lu et la fiche, qui donne aussi les travaux d'un rendez-vous hors Pixcar), pastille ; prestation ; voiture et
  immatriculation ; client · mécanicien · poste ; étiquette de provenance. Les lignes posées dépendent de la hauteur du bloc (un bloc court garde l'heure, la prestation et le client) ; tout est
  dans l'infobulle et le nom lu par les lecteurs d'écran, et la fiche s'ouvre au clic. Dans une colonne étroite (menu déplié), la
  pastille garde son icône seule (règle `@container`).
- **Filtres** repliés derrière un bouton « Filtres » (avec le nombre de filtres actifs) ; chaque filtre actif est une puce qui le retire.
- **« Nouveau »** ouvre un menu (flèches, Échap) : rendez-vous pris hors Pixcar, créneau bloqué, absence d'un mécanicien,
  indisponibilité d'un poste (mêmes règles que les fiches du lot 3a : les rendez-vous touchés apparaissent « En conflit »).
- **Semaine** : une colonne par jour ouvert ; le week-end fermé est proposé par un bouton (« Afficher le week-end ») et s'affiche de
  lui-même s'il porte un rendez-vous.
- **Pas encore possible** (données absentes) : « Pièces disponibles » sur un bloc, les « retards » dans les alertes et la création d'une
  intervention depuis « Nouveau » demandent le suivi des interventions (lot 3c).

**API** (en plus du lot 3a) :

| Route | Rôle |
|---|---|
| `GET …/calendar/agenda?from=&to=` | complétée : blocs, mécaniciens et postes, prestations et types de véhicule, plages d'ouverture de chaque jour, absences et maintenances, rendez-vous et blocs en conflit, téléphone du client |
| `POST …/calendar/blocks` | crée un bloc (`kind` : `job` ou `hold`) ; 409 `conflict` avec causes et autres horaires |
| `PUT …/calendar/blocks/:block` | modifie ou déplace un bloc ; mêmes contrôles |
| `DELETE …/calendar/blocks/:block` | supprime un bloc et libère ses ressources |

**Présentation du 24 octobre 2026** (demande de l'utilisateur, capture de l'agenda « Gestion d'atelier » de sa maquette à l'appui :
« très ressemblant […] de manière globale ; la police est trop épaisse »). Mêmes fonctions et mêmes données ; seule la présentation
change, plus trois outils de la maquette :
- **En-tête** : « Planning » (29 px), une ligne d'explication (11 px), « + Nouveau » orange (même menu qu'avant).
- **Bandeau de chiffres** à la place des quatre cartes (libellé 9 px, valeur 20 px, précision 9 px sur la même ligne) : Rendez-vous,
  Charge atelier, Mécaniciens, Alertes, avec les mêmes renvois vers les filtres ; **× le masque**, « Afficher les indicateurs » le
  rend (choix gardé dans le navigateur, `localStorage`, clé `pixcar-pro-plan-kpis`).
- **Barre d'outils** : ‹ › et la période au format de la maquette (« 26 — 30 octobre 2026 »), « Aujourd'hui », les cinq vues en
  segments, « Filtres », **« Plein écran »** (la barre latérale, le fil d'Ariane, le bandeau de chiffres et le pied de page s'effacent ;
  Échap en sort), **recherche** « Client, véhicule, immatriculation… » (dans la période affichée, sans accents ni majuscules ;
  l'immatriculation se trouve avec ou sans tirets). Le choix des colonnes, les filtres actifs et « Afficher le week-end » passent
  en petites puces sous la barre.
- **Grille** : 68 px par heure (au lieu de 90), trait à l'heure et à la demi-heure, heures « 08:00 » en 9 px, en-têtes de jours 11 px
  et charge du jour en 8 px, aujourd'hui sur fond orange pâle, **pause déjeuner hachurée et nommée** (entre deux périodes d'ouverture ;
  « Fermé » pour un jour sans ouverture).
- **Blocs** : filet gauche de 3 px et fond teinté selon l'avancement (à confirmer orange, à venir bleu, en cours bleu soutenu, en
  attente jaune pointillé, prête ou restituée vert, conflit rouge, créneau bloqué gris hachuré, client absent estompé) ; lignes : horaires
  et icône de la provenance, prestation, voiture et avancement, client et affectations, « ! Conflit de ressource » ; autant de lignes que
  la hauteur en permet (deux pour 45 min, trois pour une heure), le reste dans l'infobulle, le nom lu par les lecteurs d'écran et la
  fiche (inchangés).
- **Légende sous la grille** : avancement (pastilles), créneaux (pas proposé en ligne, fermé, absence), provenances et nombre de
  rendez-vous de la période.
- **Graisses** de tout l'Espace Pro hors accueil et connexion (déjà au gramme près de la maquette) : plus de 800, boutons et emphase à
  650, 700 pour les titres et les chiffres. Sur le tableau de bord, la part du texte en 700 passe de 45 % à 10 % (maquette : 5 %, et
  34 % en 650). Gris secondaires du Planning assombris pour le contraste AA (`#5f6571`, `#6a707b` au lieu de `#747b88`).

## Lot 3c : suivi des interventions, tableau de bord

Choix faits au début du lot (19 octobre 2026), dans le cadre des décisions ci-dessus ; à revoir sur retour de l'utilisateur.

### Suivi des interventions

En **mode avancé**, pour les rendez-vous Pixcar confirmés et les rendez-vous pris hors Pixcar (pas les créneaux bloqués). Les états sont
ceux prévus dès la migration 006 (`rdv_work_orders.status`), plus « Client absent » (`no_show_at`) :

| État | Libellé (garage) | Vu par le client | Passages possibles |
|---|---|---|---|
| `planned` | Prévue | rien de plus que « Confirmé » | Voiture reçue · Client absent (une fois l'heure de dépôt passée) |
| `received` | Voiture reçue | Voiture reçue | En cours · Prête · retour à Prévue |
| `in_progress` | En cours | Travaux en cours | En attente de pièces · Suspendue · Prête |
| `waiting_parts` | En attente de pièces | En attente de pièces | En cours · Prête |
| `suspended` | Suspendue | En attente | En cours · Prête |
| `done` | Prête | Prête | Restituée · retour à En cours |
| `returned` | Restituée | Restituée | retour à Prête |
| `no_show` | Client absent | rien | retour à Prévue (« le client est finalement venu ») |

- **Quand** : le jour du rendez-vous et jusqu'à 30 jours après (une voiture peut attendre ses pièces) ; jamais pour un jour à venir.
- **Retours en arrière** : un pas, pour corriger une erreur (colonne de droite) ; rien d'autre n'est effacé.
- **Client absent** : ses affectations ne retiennent plus leurs ressources (le moteur les ignore : on peut reprendre la place), la
  relance « prix payé » ne part pas, le client n'en est ni prévenu ni informé sur sa page. Si la place a été reprise entre-temps, un
  retour à « Prévue » est accepté et le chevauchement se voit dans le planning.
- **Commencée = figée** : au-delà de « Prévue », le rendez-vous ne se déplace plus (409 `started`, glisser compris) et un rendez-vous
  Pixcar ne s'annule plus depuis l'Espace Pro (le garage appelle le client).
- **Historique** : chaque changement est noté (`rdv_history`, `what = 'work'`), sans donnée de client.
- **E-mail « Votre voiture est prête »** (rendez-vous Pixcar) : au passage à « Prête », case « Prévenir le client par e-mail » cochée par
  défaut ; un seul par rendez-vous (un second passage à « Prête » ne renvoie rien) ; par la file d'envoi des rendez-vous (`rdv_mails`,
  `client_ready`) ; nom, adresse et téléphone du garage, ses horaires du jour, lien vers la page de suivi.
- **Page de suivi du client** (`rendez-vous/`) : dès « Voiture reçue », une frise (Voiture reçue → Travaux en cours → Prête →
  Restituée) avec l'heure du dernier changement ; « En attente de pièces » et « En attente » y prennent la place de « Travaux en cours ».
- **Données** : aucune colonne nouvelle. Un rendez-vous Pixcar a déjà sa ligne `rdv_work_orders` (`status`, `status_at`, `no_show_at`) ;
  un rendez-vous hors Pixcar en reçoit une au premier changement d'état (`request_id` = identifiant du bloc), effacée avec le bloc ; la
  purge garde les lignes dont la demande **ou** le bloc existe encore.

### Tableau de bord

Premier écran de l'Espace Pro. Tout est calculé dans la page à partir des routes existantes (agenda du jour et du lendemain, réglages
du calendrier, demandes à traiter, prix et visites), avec les mêmes règles de charge que le Planning.

**Mode avancé** (inspiré de la maquette de l'utilisateur) :

- **Cinq chiffres** : *Véhicules attendus aujourd'hui* (rendez-vous Pixcar confirmés et hors Pixcar du jour, sans les clients absents ;
  dessous : combien restent à recevoir, combien hors Pixcar) ; *Interventions en cours* (reçue, en cours, en attente de pièces,
  suspendue) ; *Véhicules prêts* (à remettre) ; *Capacité restante* (heures de main-d'œuvre encore libres aujourd'hui, à partir de
  maintenant, pour les mécaniciens présents) ; *Alertes* (nombre de points d'attention). Les trois premiers filtrent la liste du jour,
  Capacité ouvre le Planning sur la journée, Alertes mène aux points d'attention.
- **Aujourd'hui à l'atelier** : heure de dépôt, client (ou libellé), voiture et immatriculation, prestations, état (À confirmer, Prévue,
  l'état de l'intervention, Client absent) et un menu « Actions » : les passages possibles, « Ouvrir dans le planning ». Lien « Voir le
  planning complet ».
- **Actions rapides** : *Nouveau rendez-vous* (pris par téléphone ou au comptoir), *Client déjà sur place* (rendez-vous hors Pixcar au
  prochain quart d'heure, marqué « Voiture reçue » à l'enregistrement), *Bloquer un créneau*, *Déclarer une absence* : les formulaires du
  Planning. La maquette disait « Prendre un rendez-vous Pixcar » : un rendez-vous Pixcar créé par le garage pour son client supposerait
  d'enregistrer les coordonnées d'un client qui n'a rien demandé (Pixcar sous-traitant du garage) ; c'est la décision « plus tard » sur
  les rendez-vous pris hors Pixcar, inchangée.
- **Demandes à traiter** : les trois plus urgentes (Confirmer ; Refuser, avec le motif, comme dans Demandes) et le lien vers toutes.
- **Équipe & charge** : chaque mécanicien actif, sa charge du jour (planifié / disponible, %), son état maintenant (En intervention,
  Disponible, Absent, Absent à partir de…, De retour à…, Ne travaille pas aujourd'hui).
- **Postes & équipements** : état maintenant (Occupé, avec la voiture et l'heure de fin ; Disponible ; Indisponible jusqu'à… ; Fermé).
- **Points d'attention**, les plus urgents d'abord : rendez-vous en conflit, demande dont l'heure limite tombe dans les 24 heures,
  prestation faite que l'équipe ne peut pas planifier (contrôles du calendrier : compétence, poste ou équipement manquant), voiture pas
  arrivée 15 minutes après l'heure de dépôt, voiture pas prête à l'heure prévue, absence ou indisponibilité de demain, prix à confirmer.
  Quatre affichés, « Voir tous les points » pour le reste ; chacun mène à l'écran où le régler.
- **Raccourcis utiles** : trois par défaut (Planning, Prestations & tarifs, Disponibilités) ; « Personnaliser » en choisit jusqu'à six
  parmi : Planning, Demandes, Prestations & tarifs, Disponibilités, Mon garage, Équipe et postes, Nouveau rendez-vous, Fermer une
  journée, Ma fiche sur Pixcar. Gardés sur le compte pour ce garage (tous les appareils).

**Mode simple** : chiffres (rendez-vous aujourd'hui, demandes à traiter, vues de la fiche sur 30 jours, prix à jour), liste du jour
(sans états d'intervention), demandes à traiter, points d'attention (heures limites, prix à confirmer, adresse de notification
manquante), raccourcis et une invitation au calendrier avancé. **Sans rendez-vous en ligne** : chiffres des prix et des visites, points
d'attention (prix), raccourcis.

**Prestations & tarifs** : ce qu'affichait le tableau de bord jusqu'ici (prix à confirmer, chiffres des visites, tableau des prix
annoncés) devient un écran à part ; « Mes prix » prend ce nom.

**Planning** : l'état de l'intervention s'affiche sur le bloc quand il n'est plus « Prévue » ; la fiche porte les mêmes actions que le
tableau de bord ; un client absent est grisé et ne compte plus dans la charge.

### Données (migration `008_pro_prefs.sql`) et API

`pro_prefs` : préférences d'un compte pour un garage (`garage_id`, `account_id`, `shortcuts` jsonb, `updated_at`) ; aucune donnée
personnelle ; effacées avec le rattachement (`pro-revoke`).

| Route | Rôle |
|---|---|
| `POST …/rdv/calendar/work/:id` | `{ status, notify? }` : change l'état de l'intervention d'un rendez-vous Pixcar confirmé ou d'un rendez-vous hors Pixcar (`status` : un état du tableau, dont `no_show`) ; 409 `state` (passage impossible), `too_early` (jour à venir, heure de dépôt pas passée pour un absent), `simple_mode` |
| `GET …/rdv/calendar/agenda` | complétée : `work: { status, at, noShow }` pour les rendez-vous et les rendez-vous hors Pixcar |
| `POST …/rdv/calendar/blocks` | `received: true` : client déjà sur place (aujourd'hui, au prochain quart d'heure au plus tard) |
| `POST …/rdv/requests/:req/move`, `PUT …/calendar/blocks/:id`, `POST …/requests/:req/cancel` | 409 `started` au-delà de « Prévue » |
| `GET /v1/pro/garages/:id` | complétée : `prefs: { shortcuts }` |
| `PUT /v1/pro/garages/:id/prefs` | `{ shortcuts: [identifiants] }` (six au plus, sans doublon) |
| `GET /v1/rdv/me` | complétée : `progress: { status, label, at }` dès « Voiture reçue » |

## Confidentialité

Texte de confidentialité (`src/partials/legal.html`) : côté automobiliste, le type de véhicule (demandé seulement quand une prestation
a une durée par type), l'heure de restitution, l'affectation visible du seul garage et la confirmation immédiate de certaines
prestations ; côté garage, les mécaniciens (un prénom suffit, pas de compte), compétences et certifications datées, absences (aucun
motif médical demandé : la fiche le rappelle), postes, affectations et historique de 12 mois. Pour les données de son personnel, Pixcar
agit pour le compte du garage.

Conservation : les affectations partent dès qu'une demande se termine (refus, expiration, annulation) ; l'intervention (type de
véhicule, heures prévues) reste avec la demande anonymisée puis part avec elle (24 mois) ; l'historique part au bout de 12 mois
(purge quotidienne) ; le retrait d'un rattachement efface tout le calendrier du garage, par lots (`pro-revoke`).

Lot 3b (blocs internes) : le libellé d'un bloc, qui peut contenir un nom, est effacé 30 jours après le jour du bloc et la ligne
24 mois après (purge quotidienne) ; aucune coordonnée n'est demandée et aucun e-mail n'est envoyé ; l'historique ne garde pas le
libellé. Les deux textes de confidentialité le disent (`src/partials/legal.html`, côté garage ; le pied de page de l'Espace Pro). Côté
automobiliste, le texte précise que le garage voit son nom et son téléphone dans son planning et qu'un changement d'heure décidé par
le garage lui est annoncé par e-mail.

Lot 3c (suivi des interventions, tableau de bord) : l'état de l'intervention (`status`, `status_at`, `no_show_at`) suit la demande
ou le bloc et part avec lui ; l'historique note le changement sans donnée de client. Côté automobiliste, le texte dit que le garage
peut noter l'avancement, visible sur la page de suivi, qu'un e-mail « voiture prête » part sauf si le garage décoche la case, et
qu'une absence n'est vue que du garage (la relance « prix payé » ne part pas) ; la liste des e-mails comprend « voiture prête ».
Côté garage (les deux textes) : l'état des interventions et les raccourcis du tableau de bord, gardés sur le compte pour ce garage
(`pro_prefs`, aucune donnée personnelle, effacés avec le rattachement). Date du texte : 24 octobre 2026 (`src/legal.json`), à
reporter au jour de la publication si elle a lieu plus tard.

## Avant la mise en ligne du lot 3c

- Fusion de `lot3c-interventions` dans `main` (avance rapide) et poussée : **faites le 24 octobre 2026** (go de l'utilisateur :
  « Fusionne », puis « Pousse main » ; `main` = `d8880ce`).
- Déploiement de l'API (**fait le 24 octobre 2026** par l'utilisateur dans la console AWS, `docs/exploitation.md` 10.15) : migration `008_pro_prefs.sql` (1 table, aucun index) par l'opération `migrate`, droits du rôle d'exécution
  sur la nouvelle table (`ensureRuntimeRole`), puis `selfcheck` (31 contrôles ; celui des rendez-vous note en plus un client absent, dont les
  affectations ne retiennent plus leurs ressources, met l'e-mail « prête » en file une seule fois, passe l'intervention d'un bloc à
  « Voiture reçue » et écrit puis relit des raccourcis) et `smoke`. Aucune nouvelle
  ressource AWS. **L'API doit précéder le site** : la nouvelle page appelle `…/calendar/work/:id` et `…/prefs` et lit `work` et
  `prefs`, que l'ancienne API ne connaît pas ; l'ancienne page fonctionne avec la nouvelle API (elle ignore ces champs et ne peut pas
  commencer une intervention).
- Publication du site (Espace Pro, page de suivi du client) après l'API : **faite le 24 octobre 2026** (`gh-pages` `e4da3a4`,
  `docs/exploitation.md` section 2).
- Essai avec le garage d'essai : tableau de bord sur ordinateur et téléphone (chiffres, filtres, actions rapides, demandes à
  confirmer ou refuser, équipe, postes, points d'attention, raccourcis personnalisés sur deux appareils), une intervention de bout en
  bout (Voiture reçue → En cours → Prête avec l'e-mail à l'adresse de l'utilisateur → Restituée) et la page de suivi du client, un client
  absent, le mode simple.

## Avant la mise en ligne des améliorations du Planning

- Site seulement (aucune modification de l'API ni de la base) : fusion dans `main` (avance rapide, `74402b4`) et poussée, puis
  publication sur `gh-pages` (`e46f4e9`) : **faites le 19 octobre 2026**, chacune après le go de l'utilisateur
  (`docs/exploitation.md` section 2, publication (9)).
- Essai avec le garage d'essai : menu replié et déplié, vue d'ensemble et charge sur une vraie semaine, menu « Nouveau » (absence d'un
  mécanicien : rendez-vous « En conflit »), filtres, week-end, sur ordinateur et téléphone.

## Avant la mise en ligne du lot 3b

- Fusion de `lot3b-planning` dans `main` (avance rapide) et poussée : **faites le 19 octobre 2026** (go de l'utilisateur : « Tu peux
  pousser main »), avec la documentation de la publication du lot 3a et la correction des « null » des fiches.
- Déploiement de l'API (**fait le 19 octobre 2026**, `docs/exploitation.md` 10.14) : migration `007_calendar_blocks.sql` (1 table, 2 index `ASYNC`) par l'opération `migrate`, droits du rôle
  d'exécution sur la nouvelle table, puis `selfcheck` (le contrôle du calendrier écrit, relit et retire un créneau bloqué) et `smoke`.
  Aucune nouvelle ressource AWS. L'API doit précéder le site : la page du lot 3a ignore les nouveaux champs (`rdv.mode`, `blocks`,
  `days`…) et l'ancienne API ne connaît pas les routes des blocs.
- Publication du site (Espace Pro) après l'API : **faite le 19 octobre 2026** (`gh-pages` `9b5b9b2`, `docs/exploitation.md` section 2).
- Essai avec le garage d'essai : Planning (les cinq vues), déplacement d'un rendez-vous au clavier puis par glisser-déposer (e-mail au
  client), rendez-vous hors Pixcar et créneau bloqué, conflit avec une absence, sur ordinateur et téléphone.

## Avant la mise en ligne du lot 3a

- Fusion de `calendrier-avance` dans `main` (avance rapide) et poussée : **faites le 19 octobre 2026** (go de l'utilisateur : « Fusionne dans
  main et pousse »). API déployée puis site publié le même jour (`docs/exploitation.md`, 10.13 et section 2).
- Déploiement de l'API (**fait le 19 octobre 2026**, `docs/exploitation.md` 10.13) : migration `006_calendar.sql` (10 tables, 11 index `ASYNC`) par l'opération `migrate`, droits du rôle
  d'exécution sur les nouvelles tables (`ensureRuntimeRole`), puis `selfcheck` (30 contrôles, dont celui du calendrier) et `smoke`.
  Aucune nouvelle ressource AWS. L'API doit précéder le site : l'ancienne page ignore les nouveaux champs (`auto`, `needVehicle`,
  `end`, `plan`).
- Texte de confidentialité : relecture par un juriste (mécaniciens : sous-traitance pour le compte du garage, information du personnel).
- Essai de bout en bout avec le garage d'essai : assistant, activation, réservation en mode avancé (avec et sans confirmation
  immédiate), déplacement, absence en conflit, retour au mode simple.
