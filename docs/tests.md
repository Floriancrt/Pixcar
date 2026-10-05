# Tests et mesures

Ce document dit ce qui est vérifié, comment le relancer, ce que valent les mesures de performance et de charge, et surtout **ce qui n'a pas pu être vérifié**. Les chiffres datent du 3 octobre 2026, sur la machine de développement (4 cœurs, Chromium de Playwright 1.56, Node 22, PostgreSQL 16) ; ils varient d'un lancement à l'autre, **comparez des mesures faites au même moment**.

## 1. Lancer

```sh
npm ci && npx playwright install chromium     # + openssl : la suite « logos » génère son certificat HTTPS de test (tests/.out/tls/, jamais versionné)
npm run build

npm test                          # suites navigateur sur index.html (la page tout-en-un)
npm run test:dist                 # les mêmes sur dist/, servi avec ses en-têtes (CSP, types MIME, compression), + budgets de poids et hors ligne
npm run test:unit                 # magasin de réparations, client HTTP, configuration (node:test)
npm run test:server               # API sur une base PostgreSQL embarquée (PGlite)
TEST_DATABASE_URL=postgres://… npm run test:server    # la même sur un vrai PostgreSQL (le schéma est vidé !) : + migrations, verrous, délais
node scripts/build.mjs --check    # index.html et dist/ versionnés = ce que les sources produisent
npm test -- ux veh                # seulement ces suites
```

Mutations (une variante cassée volontairement doit faire échouer un test ; voir §3) :

```sh
python3 tests/mutation/mut_load.py     # chargement (24)            python3 tests/mutation/mut_ux.py     # prix, téléphones, messages… (25)
python3 tests/mutation/mut_veh.py      # véhicule (41)              python3 tests/mutation/mut_node.py   # serveur, magasin, client HTTP, DSQL, Lambda, modèle CloudFormation, mentions légales, conservation (117)
python3 tests/mutation/mut_legal.py   # fenêtre de confidentialité dans le navigateur (16)
python3 tests/mutation/mut_city.py    # ville des cartes dans le navigateur (31)    python3 tests/mutation/mut_city.py --unit   # modules/city.js, sans navigateur (13)
python3 tests/mutation/mut_ux.py --anchors    # vérifie sans navigateur que chaque ancre existe encore
```

Mesures : `node tests/perf.js` (chargement), `node tests/perf-search.js` (recherche), `DATABASE_URL=postgres://… node scripts/load-api.mjs` (API sous charge).

Les réparations arrivent-elles en base ? Deux outils, qui ne remplacent pas les suites ci-dessus :

```sh
TEST_DATABASE_URL=postgres://… node tests/demo-db.js          # démonstration locale : page → API réelle → PostgreSQL réel, contenu de la table à chaque étape (le schéma est vidé !)
node scripts/smoke-api.mjs https://api.pixcar.fr --origin https://pixcar.fr   # essai d'une API DÉPLOYÉE (voir exploitation.md, « Vérifier que les réparations arrivent en base »)
```

## 2. Ce que couvrent les tests

### Navigateur (Playwright + Chromium, services publics simulés par `tests/mocks.js`)

| Suite | Vérifie | Contrôles |
| --- | --- | --- |
| `func` | recherche, tri, filtres, rayon, contrôle technique, déclaration d'une réparation, navigation, ordinateur et mobile | 72 |
| `logos` | avatars des enseignes : logo Wikidata, icône du site, monogramme, garde-fous, cache | 62 |
| `brand` | charte Pixcar : logos, rail, jetons, marqueurs, favicon, couleurs forcées | 31 |
| `addr` | adresses manquantes (géocodage inverse, « ≈ », cache, limite de 80 m) ; la demande de ville des cartes y est coupée (`JG_CITY_LOOKUP=false`) pour que chaque requête comptée vienne d'une ouverture de fiche | 31 |
| `city` | **ville dans la puce distance** : balises OpenStreetMap, adresse lue, contrôle technique, registre SIRENE ; demande de la commune (cartes à l'écran seulement, 3 à la fois, 300 par visite, 250 m, cache et anciennes entrées, repli sur le `label`, panne puis reprise, échecs non consécutifs, interrupteur, ouverture d'une fiche pendant la demande) ; puce sur mobile (ellipsis, pas de débordement), lecteurs d'écran, axe en clair et en sombre | 47 |
| `ux` | textes, prix sans « dès », échelle de prix et ses deux médianes, téléphones, barre de défilement | 98 |
| `load` | état de chargement : rond-point animé, phrase d'attente, rien d'animé au repos | 39 |
| `veh` | immatriculation, modèle (suggestions), année, prix (bornes), stockage, confidentialité, mise en page | 194 |
| `remote` | **page en mode API, de bout en bout** : navigateur → réseau → vraie API → base ; pannes réglables (API lente, en panne, hors ligne, 429, doublon, relecture, suppression, rejeu) | 53 |
| `legal` | **fenêtre « Confidentialité et mentions légales »** : ouverture depuis le bas du panneau, « Sources et méthode » et le formulaire de déclaration (mode API), fermeture (×, Échap, fond, « Fermer »), focus et défilement bloqué, textes propres à chaque mode, axe (page entière et fenêtre, clair et sombre, téléphone), absence de lien quand `src/legal.json` est incomplet, lien du bas du panneau hors de la mise en page tant que le script n'a pas construit la page (rien ne descend sous les résultats), « Vos droits » propre à chaque mode. Construit sa propre page avec des mentions fictives | 37 |
| `prerender` | le HTML contient déjà les listes de prestations ; le script les reconstruit à l'identique (pas de décalage) | 7 |
| `budget` *(dist)* | poids gzip, chemin critique (aucune ressource tierce pour afficher), noms à empreinte, en-têtes, politique de sécurité du contenu | 29 |
| `offline` *(dist)* | service worker : la page démarre sans réseau, survit à l'arrêt de l'hébergeur, se met à jour sans casser les pages ouvertes, nettoie ses anciennes versions, **et reste à jour chez un hébergeur qui laisse la page en cache HTTP dix minutes** (GitHub Pages) | 16 |
| `pages` *(dist)* | version GitHub Pages (`--pages`) : domaine dans `CNAME`, pas de `_headers`, politique de sécurité dans une balise `<meta>` **appliquée sans aucun en-tête** (script en ligne et script étranger refusés), site fonctionnel sous cette politique, aucune violation ni erreur ; **la même version construite pour une API** (c'est ce qui est publié à l'ouverture au public ; adresse fictive interceptée par le navigateur) : adresse d'API dans la page, hôte ajouté à la politique et rien d'autre, recherche par le relais de l'API sans violation, texte du mode API dans la fenêtre de confidentialité, lien vers elle dans le formulaire de déclaration | 20 |
| `a11y` | axe-core sur les états clés (clair/sombre, ordinateur/mobile) | 13 états, 0 violation |
| `sizes`, `states`, `anchor`, `integrity` | redimensionnement, états visuels, saut de défilement sans ancrage (Safari), identifiants référencés par le script | — |
| `phone`, `cityunit`, `contrast` | lecture des numéros ; mise en forme et lecture de la ville (`modules/city.js`) ; contrastes calculés à partir des jetons livrés | 37 cas ; 56 cas ; 76 + 76 |

### Sans navigateur (`node:test`)

| Dossier | Vérifie | Tests |
| --- | --- | --- |
| `tests/unit` | magasin de réparations (file d'envoi, rejeu, reprises, abandon, annulation, zones de secours, véhicule mémorisé), client HTTP (délais, nouvelles tentatives, `Retry-After`, disjoncteur), configuration de la page | 63 |
| `server/test` | API : validation, idempotence, limites, modération, ETag/304, CORS, disjoncteur, arrêt propre, erreurs sans détail ; relais Overpass (cache, miroirs en échec, copie périmée, une seule requête amont, plafonds) ; schéma SQL et contraintes ; migrations ; contrat OpenAPI (chaque réponse produite est décrite) ; serveur Node réel (compression, 304, corps en morceaux, arrêt) ; outil de modération et effacement ; **essai de l'API déployée** (`scripts/smoke-api.mjs`) contre une vraie API (déclaration écrite, relue, rejouée, dédoublonnée, supprimée) **et contre treize API volontairement défectueuses** (site non autorisé, API ou base en panne, écriture refusée, accusé de réception sans écriture, commentaire / plaque / jour exact publiés, CORS absent à la lecture ou à l'écriture, suppression sans jeton ou refusée, « supprimé » sans effet, rejeu et doublon non détectés) : un essai qui ne sait pas échouer ne prouverait rien. **AWS** : pilote Aurora DSQL contre un connecteur simulé (reprise sur conflit, migrations asynchrones, rôle de base à moindre privilège, connexions renouvelées avant 60 minutes), adaptateur Lambda (événements API Gateway, adresse du visiteur, corps en base64, démarrage raté), fonction d'opérations (liste fermée, identifiants contrôlés), **auto-contrôle** (19 vérifications rejouées sur la base, dont la purge de conservation), SQL portable (médiane, purge par lots, mois), **paquet Lambda extrait seul** (reproductible, démarre en production, répond), et **cohérence du modèle CloudFormation avec le code** (`infra.test.mjs` : variables lues, secrets hors de la configuration, droits IAM au plus juste, délais emboîtés, base conservée à la suppression de la pile, sauvegardes : plan quotidien, coffre conservé, rôle réservé à AWS Backup), **mentions légales** (`legal.test.mjs` : le texte annonce les durées que le code et la pile appliquent et nomme chaque service que la page contacte ; le build avec l'API refuse de produire la page tant que `src/legal.json` est incomplet, échappe ses valeurs, vérifie le courriel et la durée), **conservation des déclarations** (purge des déclarations plus vieilles que la durée : par lots, tous états, calendrier ; appliquée par l'entretien du serveur et par la fonction d'opérations ; durée annoncée = durée du serveur = durée de la pile) | 232 sur PGlite · 236 sur PostgreSQL 16 (+ migrations concurrentes, verrou tenu par sa connexion, migration de plus de 5 s) |

**Résultat du 3 octobre 2026** : unitaires 63/63 ; serveur 232/232 (PGlite) et 236/236 (PostgreSQL 16) ; `npm test` et `npm run test:dist` passent en entier (toutes les suites navigateur ci-dessus), relancés après les changements pour AWS et la fenêtre de confidentialité (3 octobre 2026, `legal` : 35 contrôles) ; `remote` (page → vraie API → PostgreSQL 16, relancée à part avec `TEST_DATABASE_URL`) 53/53 et `tests/demo-db.js` conforme ; `node scripts/build.mjs --check` : à jour.

**Résultat du 4 octobre 2026** (après avoir complété `src/legal.json`, ce qui met la fenêtre et ses liens dans la page par défaut) : unitaires 63/63 ; serveur 232/232 (PGlite) ; `npm test` et `npm run test:dist` passent en entier (`legal` : 37 contrôles, `remote` : 53/53, `prerender` : 7/7, `budget` : 29/29, `offline` : 16/16, `pages` : 15/15) ; `node scripts/build.mjs --check` : à jour ; `mut_legal.py` : 16 variantes sur 16 détectées. Une phrase a été ajoutée au mode local de « Vos droits » (il ne restait que « Vous pouvez aussi saisir la CNIL ») : contrôle `L5b` et variante associée. Deux échecs de la première passe, corrigés : `remote` R1b comptait tous les blocs `data-store-only` de la page (la fenêtre légale en ajoute) au lieu de ceux de « Sources » ; `prerender` P6 (décalage de mise en page 0,0103 pour une limite de 0,005) parce que le lien du bas du panneau, déjà affiché, descendait de 144 px quand le script remplit le panneau : il est maintenant masqué dans le HTML et montré deux images après le démarrage (0,0046, comme sans lien).

**Résultat du 4 octobre 2026 (soir, la ville dans la puce distance)** : unitaires 63/63 ; serveur 232/232 (PGlite) ; `npm test` et `npm run test:dist` passent en entier, dont `city` 47/47, `cityunit` 56/56, `addr` 31/31 et `logos` 62/62 (le contrôle A9 mesure désormais l'avatar contre le bloc « nom + puce distance », voir `interface.md`) ; mutations de la ville 44/44 détectées (31 dans le navigateur, 13 sur le module). Le géocodeur inverse de l'IGN n'a jamais pu être appelé depuis cet environnement (hôte bloqué) : son format réel reste à relever dans un navigateur (`exploitation.md`, section 7).

**Vérifié sur AWS réel (3 octobre 2026, pile `pixcar` en `eu-north-1`)** : `selfcheck` 18/18 sur Aurora DSQL (opération `selfcheck` de la fonction d'opérations), migration idempotente, `scripts/smoke-api.mjs` sur l'API déployée (API Gateway → Lambda → DSQL, sous le rôle de base `pixcar_api`), comptage `ops stats` : 0 → 3 déclarations écrites par l'API → 0 après leur suppression ; modèle : cfn-lint 1.57.1 (aucun constat), cfn-guard 3.2.0 (règles « Well-Architected, pilier sécurité » : 5 écarts acceptés, justifiés dans le modèle), `ValidateTemplate` et jeu de modifications de CloudFormation (aucun résultat de validation bloquant). **Après le déploiement du 4 octobre 2026** (purge des déclarations à 24 mois, miroir « VK Maps » retiré) : `selfcheck` 19/19 sur DSQL (la 19ᵉ vérification est la purge de conservation), `scripts/smoke-api.mjs` conforme (13 contrôles), relais Overpass : 200 pour Rennes et pour Saint-Denis de La Réunion. **Essai de restauration (4 octobre 2026)** : le point de restauration planifié (120 903 octets) a été restauré en 2 min 4 s dans un cluster temporaire (actif, taille égale), supprimé ensuite, production intacte. **Non vérifié** : le comportement sous un vrai trafic (rafales ; quota Lambda passé de 10 à 1 000 le 4 octobre 2026, jamais approché), la purge sur des données réelles de plus de 24 mois, le contenu d'une sauvegarde restaurée et la bascule de l'API vers un cluster restauré, le scénario complet de `smoke-api` sur le domaine `api.pixcar.fr` (rejoué seulement sur l'adresse `execute-api`), les coûts hors essais. **Vérifié par l'utilisateur le 4 octobre 2026 dans un vrai navigateur, après l'ouverture** : `api.pixcar.fr/readyz`, déclaration réelle depuis `pixcar.fr` (enregistrée, relue après rechargement, supprimée).

### Ce que la page n'a pas le droit de faire (vérifié par `budget` et `integrity`)

Charger quoi que ce soit hors de son hébergeur pour s'afficher (seules des indications `preconnect`), contenir un script en ligne ou un `eval`, dépasser les budgets (voir §4), référencer un identifiant HTML absent.

## 3. Tests de mutation

Principe : on casse **une** règle dans une **copie** des sources (`.mut/`, ignoré par git : rien n'est modifié dans le dépôt, même si l'exécution est interrompue), on reconstruit, on lance les tests concernés, et **au moins un doit échouer**. Une variante qui survit est un trou dans les tests.

| Série | Variantes | Détectées |
| --- | --- | --- |
| Chargement (`mut_load.py`) | 24 | 24 |
| UX : « dès », téléphones, médianes, notes, barre de défilement (`mut_ux.py`) | 25 | 25 |
| Véhicule : plaque, année, modèle, stockage (`mut_veh.py`) | 41 | 41 |
| Serveur, magasin, client HTTP, DSQL, Lambda, opérations, modèle CloudFormation, mentions légales, conservation (`mut_node.py`) | 117 | 117 |
| Fenêtre « Confidentialité et mentions légales » dans le navigateur (`mut_legal.py`) | 16 | 16 |
| Ville de la puce distance dans le navigateur (`mut_city.py`) | 31 | 31 |
| Ville : mise en forme et lecture de l'adresse, `modules/city.js` sans navigateur (`mut_city.py --unit`) | 13 | 13 |

Ce que les mutations de la ville ont montré (et corrigé) : le test C7 croyait couvrir la lecture de la ville dans l'adresse en cache, mais les garages sans balise reçoivent déjà cette adresse à leur création (`adInit`) ; la branche n'est atteinte que pour un garage qui a une rue mais pas de ville (C7b). Le test B1 ne voyait pas une puce non remise à jour après une réponse tardive, parce que le tri qu'il faisait avant redessinait toutes les cartes en relisant le cache : B1 lit désormais la page telle que la recherche l'a laissée. Enfin `min-width: 0` et `max-width: 100%` sur la puce se couvrent l'un l'autre : la variante qui retire les deux est détectée, chacune seule ne change rien.

Ce qui a été trouvé **en écrivant ces mutations** (et corrigé) : un prix entre 0,01 et 0,99 € passait la validation mais violait la contrainte de la base (réponse 503 réessayée pendant 7 jours, et comptée pour le disjoncteur) ; des longueurs comptées en unités UTF-16 au lieu de caractères ; un identifiant OSM de longueur illimitée ; le plafond de requêtes simultanées vers Overpass, l'abandon à 7 jours et la péremption des zones n'étaient testés qu'« au-delà », pas « pas avant ». Une mutation **ne prouve pas** l'absence de défaut : elle mesure la force des tests sur les règles choisies.

## 4. Mesures de performance

### Poids (déterministe, `tests/budget.js`)

| | gzip | brotli |
| --- | --- | --- |
| Page (HTML + feuille de style intégrée) | 30,2 Ko (dont feuille de style 20,2) | 26,3 Ko |
| Script de l'application | 47,3 Ko | 41,8 Ko |
| Police principale (latin, Outfit) | 31,5 Ko (woff2, déjà compressée ; 26,7 Ko avec Plus Jakarta Sans jusqu'au 5 octobre 2026) | — |
| **Première visite, avant de pouvoir s'en servir** | **≈ 109 Ko** (budget 112) | **≈ 100 Ko** |
| Leaflet (chargé au premier affichage de la carte) | 41,8 Ko, à la demande | — |
| Service worker | 0,9 Ko | — |
| Visite suivante (page, script et police viennent du service worker) | 0,8 Ko transférés | — |

La page d'origine pesait 44 Ko gzip en un seul fichier mais **dépendait d'une feuille de style de Google Fonts pour s'afficher** (3 domaines tiers à joindre avant le premier affichage) ; la nouvelle page n'en demande aucun.

### Chargement sur un téléphone d'entrée de gamme simulé

Processeur ×4 plus lent, réseau 1,6 Mb/s avec 150 ms d'aller-retour, médiane de 7 chargements (`tests/perf.js`).

| Page | Visite | 1er affichage (FCP) | Plus grand élément (LCP) | Fin du chargement | Octets reçus | Décalages de mise en page (CLS) |
| --- | --- | --- | --- | --- | --- | --- |
| Ancienne page, services tiers **sans délai** | 1re | 304 ms | 508 ms | 534 ms | 134 Ko | 0 |
| Ancienne page, services tiers **avec latence modélisée** (+150 ms par requête, +600 ms à la 1re vers chaque domaine) | 1re | 900 ms | 900 ms | 1499 ms | 134 Ko | 0,001 |
| **Nouvelle page (`dist/`)** | 1re | 480 ms | 944 ms | 918 ms | 100 Ko | 0 |
| Page tout-en-un (`index.html`) | 1re | 500 ms | 860 ms | 863 ms | 126 Ko | 0 |
| Ancienne page, sans délai tiers / avec latence | suivante | 272 / 396 ms | 432 / 396 ms | 425 / 561 ms | 134 Ko | 0,085 / 0,241 |
| **Nouvelle page (`dist/`)** | suivante | **196 ms** | **196 ms** | **197 ms** | **0,8 Ko** | **0** |

Temps de blocage (TBT) à froid : ancienne page 66 ms, nouvelle page ≈ 148 ms (deux tâches longues : lecture de la page puis exécution du script).

**Lecture honnête de ces chiffres**
- **Première visite** : si les services tiers de l'ancienne page répondent instantanément (ce que fait la simulation par défaut), elle s'affiche **avant** la nouvelle (304 contre 480 ms) : la nouvelle page contient plus d'interface et plus de script à exécuter (TBT doublé). Dès que l'on modélise un coût réaliste pour la feuille de style tierce dont l'ancienne page dépend, la nouvelle s'affiche presque deux fois plus tôt (488 contre 900 ms) et finit de charger plus tôt (931 contre 1499 ms). **Le modèle de latence est le mien, pas une mesure** : *vérifie ça avec un vrai téléphone et un vrai réseau (Lighthouse, WebPageTest) avant d'en tirer une conclusion chiffrée.*
- Le « plus grand élément » de la nouvelle page apparaît à ≈ 950 ms parce qu'un paragraphe de repères est écrit par le script (l'affichage utile est à ≈ 500 ms). Le préécrire demanderait de sortir les prix des enseignes du script (et la date des promotions les rendrait périmés) : non fait.
- **Visites suivantes** : la nouvelle page s'affiche en ≈ 200 ms depuis le service worker, sans réseau, sans décalage de mise en page (l'ancienne en 400 ms à 0,1–0,24 de CLS), et **s'ouvre hors ligne**. C'est le gain le plus net.
- Le chargement est **limité par le débit** (≈ 100 Ko à 200 Ko/s) : seul un script plus léger l'abaisserait ; `app.js` (≈ 98 Ko minifiés) est le code d'origine et représente 80 % du script.

### Recherche : du clic sur « Rechercher » à la première fiche (`tests/perf-search.js`)

Un serveur Overpass simulé avec 1,5 s de latence, médiane de 5 recherches.

| Parcours | Durée |
| --- | --- |
| Directement chez les miroirs OpenStreetMap | 1845 ms |
| Via le relais, zone jamais demandée | 1857 ms (+12 ms) |
| **Via le relais, zone déjà demandée** (cache mémoire / base) | **169 / 177 ms** (−91 %) |
| Via le relais, miroirs en panne (copie périmée en base) | 166 ms (en direct : aucun résultat) |

### API sous charge (`scripts/load-api.mjs`, PostgreSQL 16 réel)

50 utilisateurs simultanés pendant 15 s : 93 % de lectures d'une zone (365 Ko de JSON), 6 % de déclarations, 1 % de suppressions ; 3200 réparations au départ ; serveur et générateur de charge **dans deux processus de la même machine**.

| Codage demandé | Lectures | Latence de lecture (médiane / 95e) | Processeur du serveur | Taille transmise |
| --- | --- | --- | --- | --- |
| aucun | 851/s | 35 / 84 ms | 85 % d'un cœur, 0,93 ms par requête | 365 Ko |
| gzip, br | 437/s *(limité par le générateur qui décompresse)* | 109 / 156 ms | 50 % d'un cœur, 1,06 ms par requête | **69 Ko** |

Aucune erreur (0 réponse 5xx, 0 erreur réseau), plan de la requête de lecture = parcours d'index. **Ce que cela dit** : une instance sert sans compression ≈ 850 lectures de 365 Ko par seconde et par cœur ; la compression (calculée une fois par version de la réponse, pas à chaque requête) coûte ≈ 0,1 ms de plus par requête. **Ce que cela ne dit pas** : le trafic réel (la plupart des lectures seront servies par le CDN) ; le comportement sur le réseau réel ; la capacité d'une base gérée. À 200 utilisateurs simultanés la latence des écritures monte à ≈ 2 s parce que le générateur, unique processus, sature avant le serveur : *ne pas lire cela comme une limite de l'API*. Ces chiffres servent à repérer un défaut (requête qui explose, verrou, erreurs), pas à dimensionner.

## 5. Ce qui n'a pas été vérifié

**Déploiement et exploitation**
- Aucun déploiement réel : hébergeur statique, CDN, répartiteur, base gérée, bascule multi-zones (leur durée dépend du fournisseur).
- **L'image Docker n'a pas été construite** (pas de démon Docker dans l'environnement). Vérifié à la place : le même jeu de fichiers, `npm ci --omit=dev`, démarrage en mode production sur PostgreSQL, sondes, arrêt propre.
- **Aucune réparation n'a été enregistrée dans une base de production** : `tests/demo-db.js` (page → API → PostgreSQL 16, tout en local, services publics simulés) et `scripts/smoke-api.mjs` (essayé contre l'API en mode production sur ce même PostgreSQL local) prouvent le mécanisme, pas un déploiement. Le premier essai réel est celui de `exploitation.md` (« Vérifier que les réparations arrivent en base »).
- Aucune charge réelle ; les mesures de §4 sont indicatives.
- Turnstile : côté serveur seulement ; la page n'envoie pas de jeton.
- Sauvegarde et restauration de la base : à tester chez l'hébergeur.

**Rendu et navigateurs**
- Seul Chromium est testé. Non essayés : **Safari / iOS, Firefox**, le rendu de la barre de défilement personnalisée sous **Windows** et **macOS**, les **claviers de téléphone** avec le masque de la plaque (Gboard, Samsung, iOS), la rotation SVG du chargement sous Safari et Firefox.
- Le mouvement de l'animation de chargement n'a pas été vu en direct (captures image par image).
- Le fond de carte réel (Plan IGN) avec le filtre désaturant : testé avec des tuiles simulées.

**Services publics (tous simulés)**
- Les logos d'enseignes eux-mêmes (Wikidata, Commons, sites des enseignes), le format réel du géocodeur inverse (`name`, `postcode`, `city`, géométrie : relu de mémoire, jamais appelé), la couverture réelle des **numéros de téléphone** dans OpenStreetMap près de chez vous, le comportement quand les miroirs Overpass ne répondent pas depuis votre réseau.
- Conditions d'utilisation et débit toléré de chaque service tiers, **dont les miroirs Overpass que le relais sollicite**.

**Données et droit**
- Le catalogue de 917 modèles est écrit de mémoire : des oublis ou des erreurs sont possibles.
- Le format de plaque SIV refuse les véhicules d'avant avril 2009 ; je ne suis pas sûr de tous les cas de renumérotation (à vérifier sur service-public.fr).
- « Case B de la carte grise » pour l'année du modèle : d'après mes souvenirs, à vérifier sur un exemplaire.
- Base légale, politique de confidentialité, durée de conservation : **à faire valider** (voir `exploitation.md`).
