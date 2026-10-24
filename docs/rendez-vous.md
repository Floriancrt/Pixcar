# Mon garage, Disponibilités et rendez-vous en ligne

Spécification des deux lots décidés avec l'utilisateur le 17 octobre 2026, d'après les maquettes de la même date
(« Espace Pro · maquettes 1 à 5 » et « Rendez-vous · maquettes 1 à 7 », hors dépôt).

- **Lot 1 — Mon garage** : la fiche du garage telle qu'il la déclare (coordonnées, horaires) et les prestations qu'il fait, avec leur
  temps moyen. Utile seul : les fiches du comparateur deviennent plus justes. **En service depuis le 18 octobre 2026** :
  détails dans [exploitation.md](exploitation.md), section 10.11.
- **Lot 2 — Disponibilités et rendez-vous** : semaine type, fermetures, règles, demandes de rendez-vous des automobilistes et leur
  traitement par le garage. **En service depuis le 18 octobre 2026** (mise en service par étapes : `docs/exploitation.md`, 10.12). À livrer d'un bloc : un planning qui n'amène aucun client ne sera pas tenu à jour.
- **Lot 3 — Calendrier avancé** (mécaniciens, postes, exigences des prestations, planification par ressources), à côté du mode simple
  ci-dessous qui reste le mode par défaut : spécification dans [calendrier-avance.md](calendrier-avance.md). Lot 3a (modèle, moteur,
  API, assistant, réservation en mode avancé) **en service depuis le 19 octobre 2026** (API et site, `docs/exploitation.md`, 10.13) ; lot 3b
  (écran Planning : cinq vues, glisser-déposer, blocs internes) **en service depuis le 19 octobre 2026** (API et site, `docs/exploitation.md`,
  10.14) ; lot 3c
  (ordres de réparation, tableau de bord) à suivre.

## Décisions

| Sujet | Décision |
|---|---|
| Ce que fait l'automobiliste d'un créneau | Il envoie une **demande** ; le garage la confirme. Pas de réservation immédiate. |
| Heure limite de réponse du garage | **Midi, le jour ouvré suivant la demande.** « Jour ouvré » : jour d'ouverture du garage d'après ses horaires (recommandation à confirmer ; à défaut, lundi à vendredi hors jours fériés). |
| Premier horaire proposé | Le plus tardif de : l'heure limite de réponse, et maintenant + le délai minimum du garage (pas leur somme). |
| Automobiliste | **Sans compte** : code à 6 chiffres par e-mail avant tout envoi, puis un lien personnel (suivre, annuler). Un lien n'agit jamais seul : il ouvre une page avec un bouton (les messageries ouvrent les liens pour les analyser). |
| Annulation par le garage d'un rendez-vous confirmé | Autorisée, avec un motif ; comptée comme une demande sans réponse pour la mise en pause automatique. |
| E-mail « nouvelle demande » au garage | Contient les coordonnées du client. |
| Mise en pause automatique | Après 3 demandes sans réponse de suite. |
| Délai de réponse affiché aux automobilistes | Plus tard, quand il y aura assez de demandes pour le calculer. |
| Temps moyen d'une prestation | **Privé** : il sert au calcul des horaires, jamais montré aux automobilistes. |
| Prestation décochée | Ne retire pas le garage des résultats. Elle ne peut ni avoir de prix annoncé ni être demandée en rendez-vous. |
| Nom, adresse, téléphone | Un changement est **relu par Pixcar** avant publication (la vérification du garage repose sur eux ; un compte piraté ne doit pas détourner les appels). Site, e-mail affiché et horaires : publiés tout de suite. |
| Données des automobilistes (lot 2) | Effacées 30 jours après le rendez-vous ; 7 jours après un refus, une annulation ou une expiration. Seul le garage concerné les reçoit. |
| Contre les abus (lot 2) | Par adresse e-mail : 1 demande en attente par garage, 3 au total ; limite par adresse IP (empreinte) ; champ piège ; horaire retenu seulement après le code, capacité revérifiée à ce moment-là. |

## Lot 1 — Mon garage

### Ce que voit le garagiste

Un onglet « Mon garage » dans le menu de l'Espace Pro (bureau : colonne de gauche ; téléphone : barre du bas, rail d'icônes à gauche depuis le 24 octobre 2026), entre « Tableau de bord » et
« Mes prix ».

1. **Coordonnées** : nom affiché, adresse, téléphone, site, e-mail affiché aux clients. Chaque ligne dit d'où vient la valeur :
   « Données publiques » (OpenStreetMap, Overture), « Vérifié par Pixcar » (changement relu), « Communiqué par le garage » (publié tout de
   suite). Un changement en attente est montré avec « Annuler la demande ». Un changement refusé est montré une fois, avec son motif.
   Les contacts privés de `garage_contacts` (e-mails, numéros servant à la vérification) **ne sont jamais montrés** : quand le garage n'a
   rien déclaré, la ligne dit « Pas encore renseigné ici ».
2. **Registre officiel** (lecture seule) : raison sociale, SIRET, code d'activité et son libellé, état. Lu dans le registre public à
   l'ouverture (même cache et même limite que la vérification). S'il ne répond pas, le reste de la page s'affiche quand même.
3. **Horaires d'ouverture** : deux plages au plus par jour, au quart d'heure ; « Copier lundi sur les jours ouvrés ».
4. **Prestations effectuées** : les 17 prestations de l'Espace Pro (contrôle technique exclu), groupées comme sur le comparateur.
   Pour chacune : « Je la fais » (oui / non ; rien tant que le garage n'a rien dit), le temps moyen (de 15 min à 8 h, au quart d'heure,
   « par pneu » ou « par roue » quand la prestation a une unité ; vide = « à saisir »), le prix annoncé ou « Annoncer un prix ».
   - Décocher une prestation qui a un prix annoncé : confirmation, puis le prix est retiré.
   - Annoncer un prix (« Mes prix ») coche la prestation.
   - Chaque changement est enregistré tout de suite.

### Données (migration `004_pro_garage.sql`)

Mêmes règles de portabilité que les migrations précédentes (PostgreSQL, PGlite, Aurora DSQL) : pas de clé étrangère, une instruction de
structure par transaction sur DSQL, index créés à part.

- `pro_profiles` (une ligne par garage, créée au premier enregistrement) : `garage_id`, `name`, `street`, `pc`, `city` (vides tant que
  rien n'est approuvé), `phone` (E.164, approuvé), `website`, `email`, `hours` (texte JSON, voir plus bas), `account_id`, `updated_at`.
- `pro_profile_changes` : `id`, `garage_id`, `field` (`name` · `addr` · `phone`), `value` (texte ; JSON pour l'adresse), `status`
  (`pending` · `approved` · `rejected` · `cancelled`), `account_id`, `reason`, `created_at`, `decided_at`. **Un seul changement en
  attente par garage et par champ** (index unique partiel) : une nouvelle demande remplace la précédente.
- `pro_services` : `garage_id`, `service_id`, `offered` (booléen), `minutes` (vide, ou 15 à 480 par pas de 15), `updated_at`.

Horaires : `{"mo":[["08:00","12:00"],["14:00","18:30"]],"tu":…,"su":[]}` ; jour absent ou liste vide = fermé ; deux plages au plus,
heures `HH:MM` au quart d'heure, début avant fin, plages dans l'ordre et sans chevauchement.

Retrait d'un rattachement (`pro-revoke`) : le profil, les changements et les prestations partent avec les prix (un nouveau titulaire
repart de zéro). Entretien : changements décidés ou annulés effacés après 90 jours.

### API (`/v1/pro`, compte connecté, garage rattaché à ce compte)

| Route | Rôle |
|---|---|
| `GET /garages/:id/profile` | Coordonnées connues (données), profil déclaré, changements en attente ou refusés récents, prestations. |
| `PUT /garages/:id/profile` | `{ website?, email?, hours? }` : publiés tout de suite ; `""` ou `null` efface. |
| `POST /garages/:id/changes` | `{ field, value }` : changement à relire (nom, adresse `{ street, pc, city }`, téléphone). 201. |
| `DELETE /garages/:id/changes/:changeId` | Annule un changement en attente. 204. |
| `PUT /garages/:id/services/:service` | `{ offered, minutes }` ; décocher retire le prix annoncé (`priceRemoved: true`). |
| `GET /garages/:id/registry` | Registre officiel de l'établissement rattaché (SIRET du rattachement). |

Lecture publique : `GET /v1/pro/public/garages` ajoute à chaque garage vérifié `profile` (seulement les champs publiés : `name`, `addr`,
`phone`, `website`, `email`, `hours`) et `services` (`offered` et `notOffered` : listes d'identifiants). **Jamais les temps moyens.**

### Relecture par Pixcar (fonction d'opérations)

- `{"op":"pro-changes"}` : changements en attente (garage, champ, valeur actuelle, valeur demandée, date).
- `{"op":"pro-change","id":"…","decision":"approve"}` ou `"reject"` avec `"reason"` (300 caractères au plus, montré au garagiste).

Chaque demande est envoyée par e-mail à Pixcar (`PRO_CONTACT`), avec les commandes pour décider ; 5 par garage et par 24 h au plus.
Pas d'e-mail au garagiste en v1 : il voit la décision à sa prochaine visite (l'API ne connaît pas l'adresse e-mail des comptes).
L'adresse approuvée ne déplace pas le garage sur la carte : la position reste celle des données (refuser et traiter à la main un
déménagement).

### Comparateur

Pour un garage vérifié, la fiche préfère les valeurs déclarées : nom, adresse, téléphone, site, horaires, e-mail (ligne ajoutée). Une
seule mention sous les lignes de la fiche dit ce que le garage a communiqué (« Adresse, téléphone, horaires, site et e-mail communiqués
par le garage, sous sa responsabilité. ») : une pastille par ligne, essayée, répétait quatre fois la même chose. La ligne sur la prestation cherchée dit « Le garage indique faire cette prestation » ou « ne pas la
faire » (sans changer le tri ni les filtres). Rien ne change pour un garage non vérifié.

## Lot 2 — Disponibilités et rendez-vous (en service depuis le 18 octobre 2026)

Ce qui suit précise la conception du 17 octobre (maquettes « Rendez-vous » 1 à 7) et tranche les points qu'elle laissait ouverts.

### Points tranchés au début du développement (18 octobre 2026)

| Sujet | Décision |
|---|---|
| Jour ouvré | **Confirmé par l'utilisateur le 18 octobre 2026.** Un jour où le garage est ouvert d'après ses horaires de « Mon garage », hors fermetures et, si le réglage est actif, hors jours fériés. Les horaires d'ouverture sont donc **obligatoires** pour ouvrir les rendez-vous en ligne (sans eux, ni jour ouvré ni contrôle des créneaux). |
| Heure limite | 12:00, heure de Paris, du premier jour ouvré qui suit le jour où la demande part (après le code). Toutes les heures limites tombent donc à midi. |
| Adresse qui reçoit les demandes | Une adresse **privée** du garage, saisie dans « Disponibilités » et vérifiée par un code envoyé à cette adresse (les demandes contiennent les coordonnées des clients : une faute de frappe les enverrait à un inconnu). Obligatoire pour ouvrir les rendez-vous. Jamais montrée aux automobilistes. |
| Liens des e-mails | Le jeton est dans le fragment de l'adresse (`rendez-vous/#c=…` pour l'automobiliste, `#g=…` pour le garage) : il n'est envoyé ni à GitHub Pages ni dans l'en-tête Referer. La page le passe à l'API dans un en-tête (`x-rdv-token`), jamais dans le chemin : les journaux de l'API notent le chemin. |
| Tâche planifiée | Toutes les heures à hh:05 (heure de Paris), appel de la **fonction de l'API** (pas de celle d'opérations) : elle a déjà la clé Scaleway et le rôle de base à moindre privilège. Expiration à midi, rappel la veille, relance de prix, e-mails restés en attente. Nouvelle ressource AWS : déployée seulement sur accord. |
| E-mails | Écrits dans une file (table `rdv_mails`) dans la même transaction que le changement d'état, envoyés juste après, et repris par la tâche horaire en cas d'échec (5 essais) : un changement d'état n'est jamais perdu faute d'e-mail. |
| Quantité | Prestations « par pneu » ou « par roue » : de 1 à 4, le temps moyen est multiplié. |
| Annulation par l'automobiliste | Possible jusqu'à l'heure du rendez-vous. |
| Relance de prix | Le lendemain du rendez-vous (une seule fois, si la case est cochée) ; le bouton ouvre le comparateur sur la zone du garage et la prestation. Le formulaire n'est pas encore prérempli : il faudrait retrouver le garage dans la liste du comparateur. |
| Fin de conservation | Nom, e-mail, téléphone, voiture, immatriculation, message, empreinte IP et jetons sont **effacés** (la ligne reste, anonyme) 30 jours après le rendez-vous, 7 jours après un refus, une annulation ou une expiration ; restent le garage, les prestations, la date et l'état, pour les totaux (taux de réponse). Ces lignes anonymes partent après 24 mois. |
| Interrupteur | `RDV_ENABLED=1` côté API (paramètre `RdvEnabled` de la pile). Fermé : `/v1/rdv/*` répond 404, la page Pro masque Demandes et Disponibilités, le comparateur n'affiche rien. |

### Données (migration `005_rdv.sql`)

Mêmes règles de portabilité que les migrations précédentes (PostgreSQL, PGlite, Aurora DSQL : pas de clé étrangère, index à part).

- `rdv_settings` (une ligne par garage) : `enabled`, `paused` (mise en pause automatique), `missed` (demandes sans réponse de suite),
  `min_delay_h` (0, 2, 4, 24 ou 48 ; 24 par défaut), `horizon_days` (7, 14, 21 ou 28 ; 28), `step_min` (15, 30 ou 60 ; 30), `holidays`
  (fermé les jours fériés ; oui), `notify_email` (adresse vérifiée) et son code en cours (`notify_pending`, empreinte, échéance, essais,
  envois), `version` (compteur que chaque prise de rendez-vous incrémente : deux demandes simultanées sur un même garage ne passent pas
  toutes deux le contrôle de capacité).
- `rdv_slots` : la semaine type. `name` (40 caractères, pour le garage seulement), `days` (`mo,tu,…`), `start_min` / `end_min` (minutes
  depuis minuit, au quart d'heure, 30 min au moins), `mode` (`hour` à l'heure, `drop` dépôt du véhicule), `capacity` (1 à 9 voitures en
  même temps), `services` (identifiants). 20 créneaux au plus par garage ; ils peuvent se chevaucher (deux ponts).
- `rdv_closures` : fermetures en dates (`first_day`, `last_day`, 90 jours au plus, 30 à venir au plus), libellé facultatif.
- `rdv_requests` : une demande. Garage, créneau, jour et heures (`day`, `start_min`, `end_min`, `starts_at` en UTC), mode, prestations et
  quantités, temps total ; nom, e-mail, téléphone, voiture, année, immatriculation (facultative), message (facultatif, 500 caractères),
  case « me rappeler de déclarer ce que j'ai payé » ; code (empreinte, échéance, essais, envois) ; empreinte IP ; empreintes des deux jetons
  (automobiliste, garage) ; `status`, `deadline`, `reason` et `note` (motif et mot du garage), `cancelled_by` (`client`, `garage`,
  `closure`) ; dates d'envoi du rappel et de la relance ; nom, adresse et téléphone du garage au moment de la demande.
- `rdv_mails` : la file d'e-mails (demande, type, essais, dernière erreur, date d'envoi). Le texte est écrit au moment de l'envoi, à partir
  de la demande : la file ne garde aucune donnée personnelle.

### États d'une demande

`code` (coordonnées saisies, code envoyé ; ne retient pas l'horaire ; effacée après 24 h) → `pending` (envoyée au garage, horaire retenu)
→ `confirmed` | `declined` (motif obligatoire) | `expired` (heure limite passée) | `cancelled` (par l'automobiliste, par le garage avec un
motif, ou par une fermeture). Un rendez-vous confirmé peut être `cancelled` par l'un ou l'autre. Une demande `pending` dont l'heure
limite est passée ne retient plus l'horaire et ne peut plus être acceptée, même avant le passage de la tâche horaire.

### Horaires proposés (`src/js/shared/rdv.js`, partagé par l'API et la page Pro)

- Temps nécessaire : somme des temps moyens des prestations demandées (× quantité). Une prestation sans temps moyen, non faite, ou
  absente du créneau ne peut pas être demandée dans ce créneau.
- Premier horaire possible : le plus tardif de l'heure limite (si la demande partait maintenant) et de maintenant + délai minimum.
- Jours : d'aujourd'hui à l'horizon, sauf fermetures, jours fériés (si le réglage est actif) et jours où le garage est fermé.
- À l'heure : de début du créneau en début + pas, tant que l'heure + le temps nécessaire tient dans le créneau **et** dans une même plage
  d'ouverture du jour (pas à cheval sur la pause de midi). Capacité : à aucun instant de [heure, heure + temps], le nombre de demandes
  `pending` (non expirées) ou `confirmed` du même créneau ce jour-là n'atteint la capacité.
- Dépôt : une proposition par jour, arrivée entre le début du créneau et une heure après (ou la fin, si elle vient avant), voiture rendue
  en fin de créneau ; le temps nécessaire doit tenir dans le créneau ; capacité : nombre de demandes du créneau ce jour-là.
- Deux créneaux qui proposent la même heure n'en font qu'une ; à l'envoi, l'API prend le premier qui a encore de la place.
- Jours fériés de métropole : 1er janvier, lundi de Pâques, 1er et 8 mai, Ascension, lundi de Pentecôte, 14 juillet, 15 août, 1er et
  11 novembre, 25 décembre.

### API

Garage (compte connecté, garage rattaché), sous `/v1/pro/garages/:id/rdv` :

| Route | Rôle |
|---|---|
| `GET /rdv` | Réglages, créneaux, fermetures, prochains jours fériés, adresse de notification (masquée si en cours de vérification), horaires d'ouverture, prestations faites avec leur temps moyen, nombre de demandes à traiter. |
| `PUT /rdv/settings` | `{ enabled?, minDelayH?, horizonDays?, stepMin?, holidays? }`. Ouvrir exige horaires, adresse vérifiée et un créneau ; rouvrir lève la pause. |
| `POST /rdv/slots`, `PUT` et `DELETE /rdv/slots/:slot` | Créneaux (contrôlés contre les horaires d'ouverture et les prestations). |
| `POST /rdv/closures`, `PUT` et `DELETE /rdv/closures/:closure` | Fermetures ; les demandes et rendez-vous de la période sont annulés, clients prévenus (`cancelled` en réponse). |
| `POST /rdv/notify`, `POST /rdv/notify/code` | Adresse de notification : envoi d'un code, puis essai du code. |
| `GET /rdv/requests?view=todo\|upcoming\|past` | Demandes, coordonnées des clients comprises. |
| `POST /rdv/requests/:req/accept`, `/decline` (`{ reason, note? }`), `/cancel` (`{ reason, note? }`) | Décisions du garage. |

Automobiliste (sans compte), sous `/v1/rdv` :

| Route | Rôle |
|---|---|
| `GET /garages/:id/times?services=vidange,montage:2` | Horaires libres (jour par jour), heure limite si l'on demandait maintenant ; 404 si le garage ne prend pas de rendez-vous en ligne pour ces prestations. |
| `POST /requests` | Coordonnées et horaire choisi : envoie le code (201). Champ piège `website`. |
| `POST /requests/:id/code`, `POST /requests/:id/resend` | Essai du code (l'horaire et la capacité sont revérifiés à ce moment) ; nouveau code. Le bon code renvoie le jeton de suivi. |
| `GET /me`, `POST /me/cancel` | Suivi et annulation, avec l'en-tête `x-rdv-token` (jeton de l'automobiliste). |
| `GET /action`, `POST /action/accept`, `POST /action/decline` | Page du garage ouverte depuis l'e-mail (en-tête `x-rdv-token`, jeton du garage, valable jusqu'à l'heure limite). |

Lecture publique (`GET /v1/pro/public/garages`) : `rdv: { services: [...] }` pour un garage qui prend des rendez-vous en ligne et a au
moins un horaire libre dans les 14 jours pour ces prestations (quantité 1).

### Contre les abus

Code à 6 chiffres valable 10 minutes, 5 essais, nouveau code 60 s après le précédent (3 envois par demande). Envois de codes : 5 par heure
et 20 par jour par adresse IP (empreinte), 5 par jour par adresse e-mail, 200 par heure pour tout le service. À l'envoi (bon code) : par
adresse e-mail, 1 demande en attente par garage et 3 au total ; 20 demandes en attente au plus par garage. Champ piège : la demande
semble partir, rien n'est envoyé. Un horaire n'est retenu qu'après le code, capacité revérifiée à ce moment.

### E-mails (Scaleway, `Pixcar <rendez-vous@pixcar.fr>`, HTML et texte)

| E-mail | À qui, quand |
|---|---|
| Code | Automobiliste, à la saisie (texte seul, code dans l'objet). |
| Demande envoyée | Automobiliste, après le code : récapitulatif, heure limite, lien de suivi. |
| Nouvelle demande | Garage (adresse de notification), après le code : coordonnées du client, boutons Accepter et Refuser (page sans connexion), réponse possible par e-mail (Reply-To : le client). |
| Confirmé | Automobiliste, à l'acceptation ; fichier d'agenda joint (`text/calendar`). |
| Refus, expiration, annulation par le garage ou pour fermeture | Automobiliste ; jusqu'à 3 autres garages proches qui prennent ces prestations en ligne, avec leur premier horaire. |
| Annulation par le client | Garage. |
| Rappel | Automobiliste, la veille à partir de 12:05. |
| Relance de prix | Automobiliste, le lendemain du rendez-vous à partir de 10:05, si la case est cochée, une fois. |
| Mise en pause | Garage, à la 3e demande sans réponse de suite (une annulation par le garage compte comme une demande sans réponse). |
| Code de l'adresse de notification | Garage. |

### Pages

- Espace Pro : « Demandes » (à traiter, à venir, passées ; accepter, refuser, annuler, appeler ; export vers l'agenda) juste après le
  tableau de bord, « Disponibilités » (interrupteur, semaine type, volet du créneau avec aperçu, fermetures, règles, adresse de
  notification) après « Mes prix ». Sur téléphone, la semaine type devient une liste par jour. Depuis le 24 octobre 2026, Disponibilités
  n'est plus un écran du menu : son contenu est dans Mon garage › Horaires (et le mode du calendrier dans Mon garage › Modules), voir
  `docs/calendrier-avance.md` (« Panneau du rendez-vous et Mon garage en rubriques »).
- Comparateur : étiquette « Rendez-vous en ligne » sous le badge « Garage vérifié », bloc « Prendre rendez-vous » dans la fiche après
  les prix annoncés (« Choisir un horaire »). Les prochains horaires ne sont pas montrés dans la fiche : il faudrait un appel à l'API à
  chaque fiche ouverte et du code de plus dans le comparateur ; ils s'affichent dès l'ouverture de la fenêtre. La fenêtre (horaire,
  coordonnées, code, envoyée) est un script et une feuille de style à part (`assets/rdv-book.*`), chargés au premier clic (+0,45 Ko gzip
  pour le comparateur). La voiture est reprise de la mémoire du comparateur (`jg.vehicles.v1`) ; les coordonnées ne sont pas gardées
  dans le navigateur.
- `rendez-vous/` : page de suivi de l'automobiliste (état, frise, agenda, itinéraire, appel, annulation) et page d'action du garage.

### Avant la mise en ligne du lot 2

- Accord de l'utilisateur pour la nouvelle ressource AWS (planification horaire) et pour le déploiement : **donné le 18 octobre 2026** ;
  rendez-vous ouverts le même jour (`docs/exploitation.md`, 10.12, étape 6).
- Adresse `rendez-vous@pixcar.fr` et fichier d'agenda (`text/calendar`) : **vérifiés le 18 octobre 2026** (envoi réel par Scaleway, reçu en
  boîte de réception Gmail, agenda reconnu, SPF, DKIM et DMARC à PASS ; `docs/exploitation.md`, 10.12, étape 3).
- Texte de confidentialité : section « Rendez-vous en ligne » (`src/partials/legal.html`), relecture par un juriste confirmée par l'utilisateur le 18 octobre 2026.
- Essai de bout en bout avec le garage d'essai : **à faire** (ouvrir ses disponibilités, demander un rendez-vous, accepter depuis l'e-mail, annuler).
