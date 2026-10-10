# Architecture

Pixcar se compose de **trois pièces indépendantes**, pensées pour que la panne de l'une ne coupe pas les autres :

```
┌───────────────────────────── navigateur du visiteur ─────────────────────────────┐
│  page (dist/)  ·  service worker (coque hors ligne)  ·  localStorage (secours)   │
└─────────┬────────────────────────┬───────────────────────────────┬───────────────┘
          │ fichiers statiques     │ réparations déclarées         │ garages, adresses, carte,
          │                        │ + relais Overpass             │ registre, logos
          ▼                        ▼                               ▼
┌───────────────────┐   ┌──────────────────────────┐   ┌───────────────────────────────┐
│ hébergeur statique│   │ API Pixcar               │   │ services publics tiers        │
│ / CDN             │   │ ≥ 2 instances, sans état │   │ IGN, SIRENE, DGCCRF, Wikidata,│
│ (dist/, HTTPS)    │   │ (server/)                │   │ miroirs Overpass              │
└───────────────────┘   └────────────┬─────────────┘   └───────────────────────────────┘
                                     │ SQL
                                     ▼
                        ┌──────────────────────────┐
                        │ PostgreSQL ≥ 14 géré,    │
                        │ multi-zones, sauvegardes │
                        └──────────────────────────┘
```

| Pièce | Rôle | Sans elle |
| --- | --- | --- |
| **Page** (`src/` → `index.html`, `dist/`) | Recherche, carte, prix, déclaration de réparation. Un seul script, une feuille de style, aucune dépendance au démarrage hors de son hébergeur. | Rien ne s'affiche (sauf visiteurs de retour : le service worker garde la coque). |
| **API** (`server/`) | Garde les réparations déclarées, les renvoie par zone, relaie et met en cache les requêtes Overpass. Aucun compte, aucune session, aucun état en mémoire dont dépende la justesse. | La page marche : prix des enseignes et réparations *de ce navigateur*, copie de la dernière zone lue. |
| **Base** (`db/migrations/`) | Réparations, garages, journal de limitation, copie des réponses Overpass. | L'API sert la dernière réponse connue (1 h) puis répond 503 ; la page continue seule. |

Principe directeur : **dégrader, ne pas échouer**. Chaque dépendance qui tombe retire une fonction, jamais la page.

Le schéma ci-dessus est celui d'un déploiement classique (instances derrière un répartiteur, PostgreSQL géré). **Sur AWS**, l'API tourne dans AWS Lambda derrière API Gateway et la base est Amazon Aurora DSQL, sans serveur à gérer (`infra/pixcar-api.yaml`, voir [exploitation.md](exploitation.md#3-bis-déployer-sur-aws-api-gateway--lambda--aurora-dsql)) : le même code, un autre adaptateur (`server/lambda.mjs`) et une autre base (§ 3).

## 1. La page

### Organisation des sources

| Chemin | Contenu |
| --- | --- |
| `src/index.html`, `src/partials/` | Gabarit et morceaux de HTML (corps, fenêtre de déclaration, sprite SVG, pictogramme de chargement). Les listes de prestations sont insérées **à la construction** (pas d'attente de script, pas de décalage de mise en page). |
| `src/css/` | `app.css`, thème sombre (`tokens.dark.css`), Leaflet. |
| `src/js/app.js` | Script d'origine (noms minifiés, modifié à la main). |
| `src/js/modules/` | `repair-store.js` (réparations), `api-client.js` (HTTP), `phone.js`, `city.js` (ville des cartes), `config.js`, `load-script.js`, `sw-register.js`. |
| `src/js/shared/` | `rules.js` (formats, bornes), `services.js` (prestations), `overpass.js` (requête et miroirs). **Importé aussi par le serveur** : la page et l'API ne peuvent pas diverger sur ce qu'est une plaque, un prix valide ou une requête Overpass autorisée. |
| `src/sw.js`, `src/assets/`, `src/data/` | Service worker, polices et icônes, catalogue des modèles. |
| `scripts/build.mjs` | Produit `index.html` (tout-en-un) et `dist/` (publiable), à l'identique d'un build à l'autre (`--check` le vérifie). |

### Deux modes pour les réparations

| | Mode local | Mode distant |
| --- | --- | --- |
| Activé par | aucune adresse d'API (défaut, `index.html` ouvert depuis le disque) | `PIXCAR_API_BASE` au build → `<meta name="pixcar-api">` |
| Les réparations vivent | dans le navigateur, `jg.repairs.v1` | en base, et dans le navigateur le temps de l'envoi |
| La fiche d'un garage montre | les réparations de ce navigateur | celles de tous, lues par zone |

La page ne parle qu'à un objet, le **magasin** (`repair-store.js`), qui expose un tableau vivant de réparations (les siennes et, en mode distant, celles de la zone, marquées `shared`). Elle ne sait pas si l'API répond.

### Ce qui se passe quand on déclare une réparation

1. La réparation reçoit **tout de suite** un identifiant (UUID v4) et un **jeton de suppression** secret (192 bits), est ajoutée au tableau et enregistrée dans le navigateur. La page l'affiche (échelle de prix, note, historique) sans attendre le réseau.
2. En mode distant, une opération « envoyer » est mise dans une **file d'attente** enregistrée (`jg.outbox.v1`) puis traitée en tâche de fond.
3. L'envoi (`POST /v1/repairs`) est **rejouable sans risque** : l'identifiant est choisi par le navigateur, l'API reconnaît une déclaration déjà reçue (même identifiant, même jeton) et répond comme la première fois.
4. En cas d'échec réseau, de délai ou d'erreur 5xx (après les nouvelles tentatives du client HTTP), l'opération reste dans la file et est **rejouée avec un délai croissant** (15 s, 30 s, … 15 min), au retour de la connexion (`online`) et au retour sur l'onglet. Un 429 respecte `Retry-After` (au moins 60 s). Au bout de **7 jours** sans succès, la déclaration est abandonnée **côté envoi** : elle reste visible sur l'appareil (« Gardée sur cet appareil »).
5. Les réponses définitives sont traitées : 201 (envoyée ; `pending` si le prix attend une relecture), 409 `duplicate` (déjà déclarée par ailleurs : la première compte, la copie locale est retirée et un message le dit), 409 `id_conflict` (identifiant déjà pris par une autre déclaration : un nouvel identifiant et un nouveau jeton sont tirés, l'envoi recommence), 400/403/413/415/422 (refusée : renvoyer à l'identique ne changerait rien, la réparation reste sur l'appareil avec un message).
6. **Annuler / Supprimer** : retire la ligne tout de suite ; si elle était partie, un `DELETE /v1/repairs/:id` avec `X-Delete-Token` suit (même file d'attente). Annuler une suppression recrée la déclaration. Une déclaration jamais partie est simplement retirée de la file.

Les réparations enregistrées **avant** l'arrivée de l'API (sans champ `sync`) ne sont **jamais envoyées d'office** : elles ont été saisies avec la promesse « rien n'est envoyé ».

### Ce que la page lit

À chaque recherche, la page demande `GET /v1/repairs?lat&lon&radius` pour la zone cherchée. La page n'attend ces réparations que **2,5 s au plus** avant d'afficher la liste : si l'API tarde, la liste s'affiche sans elles et elles apparaissent d'elles-mêmes à leur arrivée. La dernière bonne réponse de chaque zone (6 au plus, 7 jours) est gardée (`jg.area.v1`) et ressert quand l'API ne répond plus, dès le premier affichage. Les garages eux-mêmes viennent d'Overpass (via le relais de l'API en premier, puis les miroirs publics), avec le cache et les replis qui existaient déjà (liste enregistrée, registre SIRENE).

**Table de garages (dans `main`, en ligne pour la Haute-Garonne).** À côté d'Overpass, la page peut lire des **tuiles statiques** tirées d'Overture Maps, servies par le site lui-même : `garages/index.json` (version, date de construction, pas de la grille, nombre de lieux par case) et `garages/t/<y>-<x>.json`, une case de 0,25° de côté par fichier (`y = floor(lat / 0,25)`, `x = floor((lon + 10) / 0,25)` ; Cazères : `172-44`). Elle les demande **en même temps** qu'Overpass (l'index est chargé 1,5 s après le démarrage de la page, avant la première recherche), n'attend la table que **5 s au plus** (`tableWait`), ne demande que les cases que le rayon touche **et** que l'index annonce non vides (40 au plus), garde chaque promesse de case le temps de la visite (une case qui échoue n'est jamais gardée en échec), et fusionne les lieux dans la liste (`modules/garages-table.js`, `mergeTable`) : un lieu de même nom à moins de 150 m complète le garage d'OpenStreetMap de ce qui lui manque, un lieu inconnu s'ajoute (identifiant `custom:ovt-…`, source `ovt`), un doublon à moins de 40 m est écarté. L'index n'est utilisé que s'il est de la version et du pas attendus et construit il y a **moins de 180 jours** ; un échec de l'index n'est redemandé qu'au bout d'une minute. Les tuiles sont construites **hors de la page**, par `scripts/garages/build.py` (lecture d'Overture sur S3, mise en forme, doublons, retrait des établissements fermés d'après le registre SIRENE, écriture déterministe, contrôle), puis jointes à `dist/garages/` par `node scripts/build.mjs --garages <dossier>` : voir `exploitation.md`, section 8. Rien n'est gardé par la page (ni stockage du navigateur, ni cookie) et aucune requête ne part vers Overture, Meta ou Foursquare.

### Données enregistrées dans le navigateur

| Clé | Contenu | Durée |
| --- | --- | --- |
| `jg.repairs.v1` | réparations de ce navigateur (avec jeton de suppression et état d'envoi) | jusqu'à suppression |
| `jg.outbox.v1` | opérations en attente (envoi, suppression) | 7 jours au plus |
| `jg.area.v1` | dernières zones lues (secours) | 7 jours, 6 zones |
| `jg.vehicles.v1` | derniers véhicules (modèle, année, plaque) pour préremplir le formulaire | 5 au plus |
| `jg.logos.v2`, `jg.addr.v1`, `jg.osm.v3`… | caches existants (logos, adresses, garages) | selon le cache |

**La table de garages n'y laisse rien** (les tuiles passent par le cache HTTP du navigateur, comme n'importe quel fichier du site ; `jg.osm.v3` ne contient que ce qu'OpenStreetMap a répondu). Le stockage du navigateur peut être indisponible (navigation privée, quota) : tout est protégé (aucune exception), la page continue, et la fenêtre de déclaration prévient (« vous ne pourrez pas la retirer plus tard »).

### Client HTTP

`api-client.js` : délai par requête (6 s), jusqu'à 2 nouvelles tentatives avec attente exponentielle et gigue, `Retry-After` respecté (60 s au plus), nouvelles tentatives **seulement** pour une panne réseau, un délai ou 502/503/504, **disjoncteur** (3 appels échoués de suite → plus aucune requête pendant 30 s, puis une sonde ; l'événement `online` le réarme). Il ne lève jamais d'exception.

## 2. L'API

Contrat complet : [openapi.yaml](openapi.yaml). Résumé :

| Route | Rôle | Remarques |
| --- | --- | --- |
| `GET /v1/repairs?lat&lon&radius` | Réparations approuvées autour d'une **case de 0,05°** (≈ 5 km), groupées par garage | `radius` ∈ {3, 5, 10, 20, 30, 50}. Champs publics seulement : jamais commentaire, plaque ni jour exact (mois). 30 par garage et prestation (les plus récentes), 3000 au plus. |
| `POST /v1/repairs` | Déclare une réparation | 201 créée · 200 rejeu · 409 `id_conflict` / `duplicate` · 422 champs · 413/415/400 · 429 · 503. |
| `DELETE /v1/repairs/:id` | La retire | Jeton dans `X-Delete-Token`. **404 pour tout ce qui ne va pas** (identifiant inconnu, mauvais jeton) : on ne révèle pas ce qui existe. |
| `GET /v1/overpass?data=` | Relais en cache de la requête de liste des garages | N'accepte **que** la requête exacte de la page (`parseOverpassQuery`) : ce n'est pas un proxy ouvert. |
| `GET /healthz` · `GET /readyz` | Vivacité · disponibilité (503 si la base ne répond pas ou pendant l'arrêt) | |

**Lecture** : la zone est lue en base une fois par 10 s et par instance (copie en mémoire, une seule requête SQL même pour des centaines de visiteurs simultanés) ; la réponse porte `Cache-Control: public, max-age=30, s-maxage=60, stale-while-revalidate=300, stale-if-error=86400` et un `ETag` (calculé une fois par version de la réponse, 304 sur `If-None-Match`). Si la base tombe, la dernière bonne copie sert jusqu'à 1 h (`x-pixcar-stale`).

**Écriture** : une transaction vérifie le rejeu, applique les limites, crée le garage au besoin (le garage garde la case de sa première déclaration), calcule l'état (`approved`, ou `pending` si le prix est à plus de 3× ou moins de ⅓ de la médiane des déclarations approuvées de la même prestation dans la zone, avec au moins 5 déclarations), insère, journalise. Un doublon (même plaque, même garage, même prestation, même jour) est refusé par un index unique, pas seulement par le code.

**Limites** : par adresse (empreinte) et par heure pour les écritures, global par minute pour les écritures, par minute pour les lectures et pour les requêtes Overpass non servies par le cache. Réglables (voir `exploitation.md`).

**Relais Overpass** : les miroirs sont interrogés en parallèle décalé (le premier qui répond gagne), les réponses sont gardées en mémoire (bornée en nombre **et en octets**) et en base (`upstream_cache`), servies **périmées jusqu'à 7 jours** (`x-pixcar-stale`) quand tous les miroirs tombent, une seule requête amont par clé même sous charge (single-flight), au plus 4 requêtes amont simultanées. Le centre est arrondi à 3 décimales avec 100 m de marge : deux visiteurs voisins partagent la même entrée.

**Sans état** : aucune session, aucun fichier local, aucune donnée en mémoire dont la justesse dépende (les copies en mémoire ne sont que des accélérateurs). On peut donc lancer autant d'instances que nécessaire, les arrêter à tout moment, en faire tourner de plusieurs versions pendant un déploiement.

### Format d'erreur

`{ "error": { "code": "…", "message": "…", "fields": { … } } }` : un code stable, un message en français, jamais de trace ni de détail interne.

## 3. La base

Schéma : `db/migrations/001_init.sql`, pour PostgreSQL 14 ou plus **et** pour Amazon Aurora DSQL (voir plus bas).

| Table | Contenu | Conservation |
| --- | --- | --- |
| `garages` | identifiant (`osm:node/…`, `siret:…`, `custom:…`), nom, adresse, position, enseigne, case de 0,05° | un garage sans réparation est supprimé après 7 jours |
| `repairs` | prestation, prix (centimes), date, note, commentaire, modèle, année, **empreinte** de la plaque, état (`approved`, `pending`, `rejected`), **empreinte** du jeton de suppression (empreintes : 64 caractères hexadécimaux) | jusqu'à suppression par son auteur, par la modération ou à la demande, et au plus **`REPAIR_RETENTION_MONTHS` mois (24)** après le dépôt (purge quotidienne) |
| `write_log` | empreinte de l'adresse IP (64 caractères hexadécimaux), instant (limitation des écritures) | 30 jours |
| `upstream_cache` | dernières réponses d'Overpass | 14 jours |

Les `CHECK` de la base répètent la validation de l'API : **même une erreur de l'API ne peut pas y inscrire un prix négatif ou une note de 9**. Index : lecture d'une zone (`garages_area_idx`, `repairs_garage_service_idx`, index partiels sur `approved`), unicité anti-doublon, file de modération, limitation.

**Migrations** : `server/migrate.mjs` applique les fichiers `NNN_nom.sql` pas encore appliqués, chacun dans une transaction, sous un **verrou consultatif pris sur une connexion dédiée** (plusieurs instances qui démarrent ensemble : une seule migre, les autres attendent, 120 s au plus). Une migration qui échoue est annulée en entier et libère le verrou. Règle de déploiement : une migration doit rester **compatible avec la version précédente de l'API** (ajouter avant d'utiliser, supprimer après), pour qu'un déploiement progressif ne casse rien. *Sur Aurora DSQL, la migration procède autrement (tableau ci-dessous).*

### Deux bases, un seul schéma

Le même fichier de migration et le même SQL (`server/repo.mjs`) servent PostgreSQL (via `pg` ; PGlite, une base embarquée, en développement) et Amazon Aurora DSQL (PostgreSQL distribué, sans serveur, sur AWS). DSQL a des contraintes que PostgreSQL n'a pas ; elles ont façonné le schéma et le code :

| Contrainte d'Aurora DSQL | Conséquence |
| --- | --- |
| Pas d'index sur `bytea` | les empreintes sont du **texte hexadécimal de 64 caractères** (`CHECK (char_length(…) = 64)`), calculées par l'API (`toHex`), jamais des octets |
| Index construits en tâche de fond (`CREATE INDEX ASYNC`), sans `DESC` | `server/lib/sql.mjs` adapte chaque `CREATE INDEX` du fichier de migration pour DSQL ; la migration **attend la fin de chaque construction** (`sys.jobs`) et n'enregistre la version qu'à la fin. Sur PostgreSQL, le fichier s'exécute tel quel |
| Une seule instruction de définition par transaction | sur DSQL, la migration passe instruction par instruction (chacune rejouable : `IF NOT EXISTS`) |
| Pas de verrous consultatifs | pas de verrou de migration sur DSQL : la migration se lance **à la main, une fois par déploiement** (fonction d'opérations), jamais au démarrage des instances |
| Conflits de concurrence optimiste (SQLSTATE 40001, `OC000` / `OC001`) | chaque requête et chaque transaction est **rejouée** (4 fois, attente croissante) par `withRetry` (`server/db.mjs`) ; le code d'une transaction ne fait donc rien en dehors d'elle |
| 3 000 lignes modifiées au plus par transaction | la purge supprime **par lots de 1 000** |
| Connexion fermée au bout de 60 minutes | le pool renouvelle ses connexions à 50 minutes |
| Pas de mot de passe : jeton IAM, rôles de base liés à des rôles IAM | l'API se connecte sous le rôle `pixcar_api` (lecture et écriture des 4 tables, rien d'autre) ; `admin` ne sert qu'à la fonction d'opérations (`ensureRuntimeRole`) |
| Fonctions SQL | du SQL des plus courants : `rank()`, médiane lue par `OFFSET`, mois et délais calculés en JavaScript : même résultat sur PostgreSQL, vérifié par les tests |

**Vérifié sur Aurora DSQL réel (3 et 4 octobre 2026)** : l'opération `selfcheck` (`server/selfcheck.mjs`) rejoue 19 vérifications sur la vraie base (18 le 3 octobre ; la 19ᵉ, la purge de conservation des déclarations, le 4 octobre) (index valides, création, rejeu, doublons, deux cas de concurrence, relecture des prix, effacement, purge par lots, cascade…) et elles passent toutes ; l'essai de bout en bout de l'API déployée (`scripts/smoke-api.mjs`) aussi. Écart constaté avec la documentation de DSQL : `GRANT USAGE ON SCHEMA public` est refusé (« feature not supported on system entity »), le rôle `pixcar_api` n'en a pas besoin pour accéder aux tables. **Reste à confirmer sous trafic réel** : conflits de concurrence fréquents ou non, latences, consommation de DPU par requête.

## 4. Confidentialité et sécurité

| Donnée | Où | Comment |
| --- | --- | --- |
| Plaque d'immatriculation | envoyée à l'API, jamais stockée en clair | `HMAC-SHA256(PLATE_PEPPER, plaque)` (hexadécimal), utilisée seulement pour repérer un doublon ; jamais renvoyée ni affichée |
| Adresse IP | jamais journalisée en clair ni stockée en clair | `HMAC-SHA256(IP_PEPPER, adresse)` (hexadécimal) dans `write_log`, 30 jours, pour limiter le débit |
| Jeton de suppression | clair dans le navigateur de l'auteur, empreinte SHA-256 (hexadécimal) en base | permet à son auteur de retirer sa déclaration, sans compte |
| Commentaire | envoyé, stocké, **jamais renvoyé** par l'API publique | lisible seulement par la modération (`moderate.mjs list`) |
| Prix, mois, modèle, année, note, garage | publics | affichés dans la fiche du garage, sans nom |

- **Aucun cookie, aucun compte, aucune session** côté Pixcar. Les requêtes vers l'API sont faites sans identifiants (`credentials: "omit"`). La mesure d'audience Google Analytics, active seulement dans la version publiée, dépose ses cookies **après l'accord du visiteur** (bandeau de consentement : voir [interface.md](interface.md#mesure-daudience-google-analytics)).
- **CORS** : seules les origines de `ALLOWED_ORIGINS` sont autorisées ; la réponse expose seulement `Retry-After`, `X-Pixcar-Stale`, `X-Request-Id`.
- **Politique de sécurité du contenu** (`dist/_headers`) : pas de script en ligne ni d'`eval` ; une seule feuille de style en ligne, autorisée par son empreinte (les attributs `style` restent permis : positions des repères de l'échelle de prix), `frame-ancestors 'none'`, `object-src 'none'`, `connect-src` limité aux services utilisés **et à l'adresse de l'API** ; `nosniff`, `Referrer-Policy`, `Permissions-Policy`, `COOP`, HSTS. Avec la mesure d'audience (version publiée), `script-src` y ajoute `googletagmanager.com` et `connect-src` les hôtes de mesure de Google (quatre adresses : `scripts/build.mjs`, `GOOGLE_CONNECT`).
- **Entrées** : toute valeur est validée à l'entrée (types, bornes, longueurs, caractères de contrôle) puis par les contraintes SQL ; les paramètres SQL sont toujours passés séparément ; le relais Overpass n'accepte qu'une requête de forme connue.
- **Anti-abus** : limites par empreinte d'adresse, plafond global, relecture des prix aberrants, **Turnstile facultatif** (`TURNSTILE_SECRET`, côté serveur seulement : *le côté page n'est pas branché*, voir `exploitation.md`).
- **Journaux** : une ligne JSON par requête (méthode, chemin **sans** paramètres, statut, durée, identifiant de requête) ; ni adresse IP, ni corps, ni requête.

**Points à faire valider avant publication (je ne suis pas juriste)** : la plaque, même sous forme d'empreinte, reste une donnée personnelle (pseudonymisée) ; il faut une base légale, une information des visiteurs (politique de confidentialité), une durée de conservation décidée, et une procédure d'effacement (`moderate.mjs forget`, voir `exploitation.md`). La fenêtre « Confidentialité et mentions légales » (`src/partials/legal.html`, informations de l'éditeur dans `src/legal.json`) décrit ces points ; le build avec l'API refuse de produire la page tant que ce fichier est incomplet (voir exploitation.md, § 6). Le texte de la fenêtre de déclaration, lui, ne remplace pas cette politique.

## 5. Disponibilité

Un taux de disponibilité chiffré (99,9 %…) **ne se promet pas dans le code** : il dépend de l'hébergeur statique, de la base gérée et des services tiers. Ce que le code garantit :

- **Aucun point de défaillance unique propre à l'application** : page statique (CDN), API sans état (≥ 2 instances ; sur AWS, Lambda répartit les exécutions sur plusieurs zones), base gérée multi-zones (à choisir ainsi ; DSQL l'est par conception).
- **Dégradation plutôt que panne** : voir la matrice ci-dessous.
- **Déploiements sans interruption** : `/readyz` passe à 503 au signal d'arrêt (le répartiteur retire l'instance), l'instance finit ses requêtes (5 s au plus par défaut) puis s'arrête ; les migrations sont compatibles avec la version précédente.
- **Nouvelles tentatives sûres** : toutes les requêtes de la page sont rejouables (lecture, déclaration à identifiant fixe, suppression).
- **Limites de ressources** : délais partout (connexion à la base 3 s, requête 5 s, requête HTTP 10 s, miroirs Overpass), pool de connexions borné, caches bornés en taille, concurrence amont bornée, corps de requête limité.

### Que se passe-t-il quand… ?

| Panne | Ce que voit le visiteur | Ce qui le garantit |
| --- | --- | --- |
| **Hébergeur statique / CDN** | Visiteur de retour : la page s'ouvre quand même (service worker). Nouveau visiteur : rien. | Coque en cache, copies de l'ancienne génération conservées ; **c'est le maillon à choisir avec un CDN** (plusieurs points de présence, SLA). |
| **Une instance de l'API** | Rien (le répartiteur l'évite). | ≥ 2 instances sans état, `/readyz`, nouvelles tentatives côté page. |
| **Toutes les instances de l'API** | Prix des enseignes et réparations de ce navigateur ; encart « momentanément indisponibles » ; les déclarations sont gardées et partent au retour. | Mode dégradé du magasin, file d'envoi, copie de la dernière zone (7 jours), disjoncteur (la page n'attend pas). Les lectures déjà en cache CDN continuent (`stale-if-error` 1 jour). |
| **La base** | Lectures : la dernière copie de la zone (1 h au plus) si l'instance reste dans le répartiteur, sinon le CDN (`stale-if-error`, 1 jour), puis la copie du navigateur (7 jours). Écritures : 503 + `Retry-After` → la page garde la déclaration et réessaie. | Copie de la dernière bonne réponse, disjoncteur (4 échecs → 5 s sans attendre la base), `/readyz` 503 (voir `exploitation.md` : choix de la sonde du répartiteur). |
| **Bascule de la base (multi-zones)** | Quelques dizaines de secondes à quelques minutes d'écritures en 503 (durée propre au fournisseur : à vérifier chez lui). | Idem : file d'envoi côté page, reprise automatique des connexions. |
| **Tuiles de la table de garages** (index absent, case en échec, table périmée de plus de 180 jours, délai de 5 s) | Rien : la liste est celle d'OpenStreetMap, sans message ; une case en échec est redemandée à la recherche suivante, un index en échec au bout d'une minute. Si OpenStreetMap répond aussi mal, la liste vient de la table (avec une note). | Table facultative par construction (chargée en parallèle, jamais attendue au-delà de 5 s), garde de fraîcheur, lecture défensive de chaque tuile (`cleanTile`), `tests/garages.js` D, E, F. **La reconstruction mensuelle doit être surveillée** : sans elle la table s'éteint seule au bout de six mois. |
| **Miroirs Overpass** | Les zones déjà demandées sont servies (même périmées, jusqu'à 7 jours). Une zone jamais demandée : liste enregistrée ou registre SIRENE, sans phrase d'explication. | Relais + cache mémoire et base, repli existant de la page. |
| **IGN (carte, adresses)** | Pas de carte ni de recherche d'adresse. | **Point de défaillance unique non couvert** (services publics tiers, pas de substitut). |
| **API Wikidata, sites des enseignes** | Monogrammes à la place des logos. | Repli prévu. |
| **Navigateur hors ligne** | La page s'ouvre (visiteur de retour), la dernière liste enregistrée s'affiche, les déclarations partent au retour du réseau. La table de garages n'est pas disponible hors ligne : ses tuiles ne passent pas par le service worker (réseau et cache HTTP seulement). | Service worker, caches `localStorage`, file d'envoi. |

## 6. Performances

Chemin critique d'une première visite : **une page HTML avec sa feuille de style intégrée (signée par empreinte dans la CSP), un script différé à nom haché, une police préchargée**, rien d'autre avant l'affichage. Leaflet (147 Ko avant compression) n'est chargé qu'à la première carte, depuis le site puis, à défaut, un CDN. Les listes de prestations et leur texte d'aide sont écrits dans le HTML (pas de tirette vide, pas de décalage de mise en page).

| Étage de cache | Durée | Pour quoi |
| --- | --- | --- |
| Navigateur, fichiers à nom haché (`/assets/*`) | 1 an, `immutable` | JS, polices, Leaflet |
| Page et `sw.js` | `no-cache` (revalidés à chaque visite, 304 si inchangés) | un déploiement est vu dès la visite suivante |
| Service worker | coque complète, génération courante + précédente | visites suivantes sans réseau |
| CDN devant l'API | `s-maxage=60` (zone), 3600 (Overpass) ; périmé servi pendant la revalidation (5 min / 1 jour) et en cas d'erreur (1 jour / 7 jours) | la majorité des lectures n'atteint jamais l'API |
| Instance de l'API | 10 s par zone (copie en mémoire), réponse compressée et empreinte calculées **une fois** par version | des centaines de lecteurs = une requête SQL |
| Base | index sur la zone et sur (garage, prestation, date) | lecture d'une zone par parcours d'index |

Budgets (vérifiés par `tests/budget.js`, lancé par `npm run test:dist`) : page ≤ 30 Ko gzip (dont feuille de style ≤ 22), script ≤ 58 Ko (52 avant la table de garages et Mapbox), police ≤ 34 Ko, **première visite ≤ 118 Ko** (112 avant), service worker ≤ 3 Ko. Les mesures (chargement sur téléphone d'entrée de gamme simulé, API sous charge) sont dans [tests.md](tests.md).

**Si le trafic augmente** : l'API est sans état, on ajoute des instances ; la lecture est surtout absorbée par le CDN ; la base ne voit qu'une requête de zone par instance toutes les 10 s et par zone chaude ; les écritures sont rares (quelques-unes par minute) et plafonnées. Le premier maillon à surveiller est le pool de connexions de chaque instance (`PG_POOL_MAX`) multiplié par le nombre d'instances face au maximum de connexions de la base.

## 7. Décisions et alternatives écartées

- **Pas de comptes** : demandé (« pas de session utilisateur »). Le droit de retirer une déclaration repose sur un jeton gardé dans le navigateur ; la contrepartie (jeton perdu = déclaration non retirable par son auteur) est assumée et couverte par l'effacement à la demande.
- **API sans framework, `fetch(Request) → Response`** : portable (Node, AWS Lambda, Cloudflare Workers, Deno) et testable sans réseau ; deux adaptateurs sont fournis : Node (`server/index.mjs` : écoute, compression, arrêt propre) et AWS Lambda (`server/lambda.mjs` : événements d'API Gateway HTTP API 2.0, adresse du visiteur fournie par la passerelle). Le code de base de données cible PostgreSQL via `pg` et Aurora DSQL : *un déploiement sur Workers demanderait un pilote HTTP (non fait ni testé).*
- **AWS : API Gateway (HTTP API) + Lambda + Aurora DSQL** plutôt que des conteneurs derrière un équilibreur avec une base PostgreSQL gérée : pas de serveur ni de réseau privé à tenir à jour, pas de forfait mensuel pour un site qui démarre, plusieurs zones par conception, et le même code (le repli, si DSQL déçoit à l'essai : `DATABASE_URL` vers un PostgreSQL géré et l'adaptateur Node). Contreparties assumées : pas de cache devant l'API dans ce premier déploiement (voir exploitation.md), une base plus récente et plus contraignante que PostgreSQL (tableau du § 3), un démarrage à froid à mesurer. Lambda « Web Functions » (le serveur Node tel quel) a été écarté : d'après la documentation d'AWS lue le 3 octobre 2026, un nom de domaine à soi passe par CloudFront, donc par un certificat en `us-east-1`, hors de la région du projet (*à revérifier si l'option est rouverte*).
- **Une fonction d'opérations au lieu d'un accès direct à la base** : DSQL n'est joignable qu'avec un jeton IAM, et le protocole PostgreSQL ne traverse pas tous les réseaux ; les droits d'administration restent dans AWS (rôle de la fonction) au lieu d'un poste de travail, et la liste des opérations est **fermée** (pas de SQL libre).
- **Cases de 0,05° plutôt que rayon exact** : toutes les lectures d'une même case sont identiques, donc **mises en cache** (CDN, instance) ; la page affine à la distance exacte.
- **Compression** : assurée par le CDN ou le répartiteur en production ; l'adaptateur Node compresse aussi (une fois par version d'une réponse, pas à chaque requête) pour fonctionner seul.
- **Relais Overpass plutôt que miroirs seuls** : les miroirs publics sont lents et parfois saturés ; le relais mutualise les requêtes et garde une copie pendant leurs pannes.
- **Modération automatique minimale** : seule règle, un prix à plus de 3× / moins de ⅓ de la médiane locale attend une relecture. Ce n'est pas une protection contre un abus organisé.

- **Table de garages : des tuiles statiques construites hors ligne, plutôt qu'une API ou une base** (choix de l'utilisateur après l'évaluation de la Haute-Garonne, 6 octobre 2026, branche `evaluation-sources`) : une table que **nous** gardons coûte de la construction et de la reconstruction, mais **aucun appel à un service tiers par recherche**, aucun secret, aucune ressource AWS, aucune dépendance aux conditions d'usage d'un fournisseur (**à vérifier** pour Mapbox : conservation des réponses), et un coût de diffusion presque nul (8 Ko pour une recherche autour de Cazères). Écartées : *une API qui rend les lieux d'une zone* (une ressource à exploiter pour des données qui ne changent qu'une fois par mois) ; *copier les lieux dans la base des réparations* (mélanger des données ouvertes d'origine variée avec des déclarations de visiteurs). **La complétion par Mapbox (branche `mapbox-fiches`) n'est pas exclue** : elle apporte les horaires que la table n'a pas ; les deux se combinent, mais `git merge-tree` (6 octobre 2026) annonce des **conflits** entre `garages-table` et `mapbox-fiches` dans `src/js/app.js`, `scripts/build.mjs`, `src/css/app.css` et `src/index.html` (les deux branches ajoutent leurs blocs aux mêmes endroits ; `index.html` et `dist/` se régénèrent) : la seconde fusion se résout à la main puis `npm run build` et la régression, et la complétion Mapbox devra admettre les garages « ovt » à l'ouverture d'une fiche. **OpenStreetMap reste la source principale** : la table ne remplace jamais un champ qu'il renseigne, et la liste reste celle d'OpenStreetMap si la table manque.
- **Grille de 0,25° et un fichier par case** : une recherche à 10 km lit 1 à 4 fichiers (Cazères : 4, 8 Ko ; centre de Toulouse : 2, 47 Ko ; centre de Paris : 2, 142 Ko) qui se mettent en cache comme les autres fichiers du site ; pas de requête de zone, pas de serveur. Contrepartie : en ville dense la case est lourde (la plus grosse du rectangle de Paris : 363 Ko de JSON, 99 Ko compressés) ; un pas plus fin (0,125°) est prévu dans le format (l'index porte le pas, la page refuse un autre pas) mais n'est pas fait.
- **Règle de rapprochement écrite deux fois (JavaScript et Python), comparées par un test** plutôt qu'un seul code partagé : la page ne peut pas charger du Python, et la construction ne doit pas dépendre d'un paquet JavaScript ; `diff_js.mjs` compare les deux sur des milliers de paires à chaque test.
- **Les lieux fermés sont retirés à la construction, d'après le registre SIRENE, jamais copiés** : le registre ne sert que de filtre (rien de lui n'est écrit dans les tuiles) ; limite connue : il ne voit presque pas les entrepreneurs individuels (40 % de ses établissements en Haute-Garonne, 5 % rapprochés), où se trouve une bonne part des fermetures non détectées.
