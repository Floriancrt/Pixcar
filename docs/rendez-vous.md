# Mon garage, Disponibilités et rendez-vous en ligne

Spécification des deux lots décidés avec l'utilisateur le 17 octobre 2026, d'après les maquettes de la même date
(« Espace Pro · maquettes 1 à 5 » et « Rendez-vous · maquettes 1 à 7 », hors dépôt).

- **Lot 1 — Mon garage** : la fiche du garage telle qu'il la déclare (coordonnées, horaires) et les prestations qu'il fait, avec leur
  temps moyen. Utile seul : les fiches du comparateur deviennent plus justes. **Écrit et testé (branche `mon-garage`), pas en service** :
  mise en service dans [exploitation.md](exploitation.md), section 10.11.
- **Lot 2 — Disponibilités et rendez-vous** : semaine type, fermetures, règles, demandes de rendez-vous des automobilistes et leur
  traitement par le garage. Conçu ici, **pas commencé**. À livrer d'un bloc : un planning qui n'amène aucun client ne sera pas tenu à jour.

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

Un onglet « Mon garage » dans le menu de l'Espace Pro (bureau : colonne de gauche ; téléphone : barre du bas), entre « Tableau de bord » et
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

Pas d'e-mail au garagiste en v1 : il voit la décision à sa prochaine visite (l'API ne connaît pas l'adresse e-mail des comptes).
L'adresse approuvée ne déplace pas le garage sur la carte : la position reste celle des données (refuser et traiter à la main un
déménagement).

### Comparateur

Pour un garage vérifié, la fiche préfère les valeurs déclarées : nom, adresse, téléphone, site, horaires, e-mail (ligne ajoutée). Une
seule mention sous les lignes de la fiche dit ce que le garage a communiqué (« Adresse, téléphone, horaires, site et e-mail communiqués
par le garage, sous sa responsabilité. ») : une pastille par ligne, essayée, répétait quatre fois la même chose. La ligne sur la prestation cherchée dit « Le garage indique faire cette prestation » ou « ne pas la
faire » (sans changer le tri ni les filtres). Rien ne change pour un garage non vérifié.

## Lot 2 — Disponibilités et rendez-vous (conçu, pas commencé)

### Garage

- **Semaine type** de créneaux : jours, horaires, prestations acceptées, voitures en même temps, mode « à l'heure » ou « dépôt du
  véhicule » (arrivée dans la première heure, voiture rendue en fin de créneau). Les créneaux restent dans les horaires d'ouverture et
  peuvent se chevaucher.
- **Fermetures** en dates ; jours fériés fermés automatiquement (désactivable). Une fermeture annule les demandes déjà envoyées sur
  la période (client prévenu).
- **Règles** : délai minimum, horizon (4 semaines), pas des horaires proposés (30 min), interrupteur « Rendez-vous en ligne ».
- **Demandes** : à traiter, à venir, passées ; accepter, refuser (motif obligatoire, mot facultatif), annuler un rendez-vous confirmé
  (motif). Les boutons de l'e-mail ouvrent une page limitée à cette demande, sans connexion, valable jusqu'à l'heure limite.

### Automobiliste

Fiche → horaire → coordonnées (nom, e-mail, téléphone, voiture ; immatriculation et message facultatifs ; case décochée « me rappeler
de déclarer ce que j'ai payé ») → code par e-mail → demande envoyée → page de suivi par le lien personnel (jeton aléatoire gardé haché,
valable jusqu'à 7 jours après le rendez-vous).

Horaires proposés : temps moyens des prestations demandées additionnés, dans un même créneau, capacité respectée ; aucun horaire avant
l'heure limite de réponse du garage.

### E-mails (Scaleway, `rendez-vous@pixcar.fr`)

Code ; demande envoyée ; nouvelle demande (garage) ; confirmation (fichier d'agenda) ; refus ou expiration (avec d'autres garages qui
prennent la prestation en ligne) ; rappel la veille ; relance de prix (seulement si la case est cochée, une fois). Le garage a besoin
d'une adresse de notification privée (à ajouter au profil).

### Avant la mise en ligne du lot 2

- **Tâche planifiée** (expiration à midi, rappel la veille) : nouvelle ressource AWS, sur accord de l'utilisateur.
- Texte de confidentialité complété (données des automobilistes) et avis d'un juriste (Pixcar devient intermédiaire de rendez-vous).
