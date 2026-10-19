# Calendrier avancé (Espace Pro)

Le **mode simple** est celui du lot 2 ([rendez-vous.md](rendez-vous.md)) : une semaine type en créneaux, chacun avec sa capacité. Le
**mode avancé** calcule les horaires proposés à partir des **ressources réelles** de l'atelier : mécaniciens (horaires, absences,
compétences, prestations autorisées), postes et équipements (pont, banc, station…), et ce que demande chaque prestation. Le garage choisit
son mode dans Disponibilités ; passer de l'un à l'autre ne perd rien.

Découpage : **lot 3a** (ce document : modèle, moteur, API, assistant, réservation en mode avancé), lot 3b (calendrier multi-vues,
glisser-déposer, blocs internes), lot 3c (interventions, tableau de bord). Plus tard : stock, statistiques avancées, comptes mécaniciens.

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

## Confidentialité

Texte de confidentialité (`src/partials/legal.html`) : côté automobiliste, le type de véhicule (demandé seulement quand une prestation
a une durée par type), l'heure de restitution, l'affectation visible du seul garage et la confirmation immédiate de certaines
prestations ; côté garage, les mécaniciens (un prénom suffit, pas de compte), compétences et certifications datées, absences (aucun
motif médical demandé : la fiche le rappelle), postes, affectations et historique de 12 mois. Pour les données de son personnel, Pixcar
agit pour le compte du garage.

Conservation : les affectations partent dès qu'une demande se termine (refus, expiration, annulation) ; l'intervention (type de
véhicule, heures prévues) reste avec la demande anonymisée puis part avec elle (24 mois) ; l'historique part au bout de 12 mois
(purge quotidienne) ; le retrait d'un rattachement efface tout le calendrier du garage, par lots (`pro-revoke`).

## Avant la mise en ligne du lot 3a

- Fusion de `calendrier-avance` dans `main` (avance rapide) et poussée : **faites le 19 octobre 2026** (go de l'utilisateur : « Fusionne dans
  main et pousse »). API déployée le même jour (`docs/exploitation.md`, 10.13). Reste, avec son go : la publication du site.
- Déploiement de l'API (**fait le 19 octobre 2026**, `docs/exploitation.md` 10.13) : migration `006_calendar.sql` (10 tables, 11 index `ASYNC`) par l'opération `migrate`, droits du rôle
  d'exécution sur les nouvelles tables (`ensureRuntimeRole`), puis `selfcheck` (30 contrôles, dont celui du calendrier) et `smoke`.
  Aucune nouvelle ressource AWS. L'API doit précéder le site : l'ancienne page ignore les nouveaux champs (`auto`, `needVehicle`,
  `end`, `plan`).
- Texte de confidentialité : relecture par un juriste (mécaniciens : sous-traitance pour le compte du garage, information du personnel).
- Essai de bout en bout avec le garage d'essai : assistant, activation, réservation en mode avancé (avec et sans confirmation
  immédiate), déplacement, absence en conflit, retour au mode simple.
