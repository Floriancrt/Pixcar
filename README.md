# Pixcar

Comparateur de prix de garages : une page unique (carte, vues « Garages » et « Prix et promos », déclaration de réparation) et une petite API qui garde en base les réparations déclarées par les visiteurs, pour que chacun voie ce que les autres ont payé près de chez lui. Sans compte ni session.

Ce dossier est indépendant du thème Shopify du dépôt (un thème Shopify ne contient que `assets/`, `config/`, `layout/`, `locales/`, `sections/`, `snippets/` et `templates/`).

## Ce qu'il y a dedans

| Chemin | Contenu |
| --- | --- |
| `src/` | **Sources de la page** (HTML en morceaux, CSS, JS, service worker). C'est ici qu'on modifie. |
| `src/legal.json` | Informations de l'éditeur pour la fenêtre « Confidentialité et mentions légales » : complété le 4 octobre 2026 ; si un champ est vidé, le build avec l'API refuse de produire la page (voir `docs/exploitation.md`, section 6). |
| `index.html` | Page tout-en-un **générée** (CSS, JS, police en ligne) : s'ouvre depuis le disque. Ne pas modifier à la main. |
| `dist/` | Site **publiable généré** : fichiers à nom haché, service worker, en-têtes de cache et de sécurité. Ne pas modifier à la main. |
| `server/` | L'API (Node ≥ 20, sans framework), le relais Overpass, les outils de migration et de modération. |
| `db/migrations/` | Schéma, pour PostgreSQL et pour Amazon Aurora DSQL. |
| `infra/` | Modèle CloudFormation de l'API sur AWS (API Gateway + Lambda + Aurora DSQL). |
| `docs/` | Documentation (voir plus bas) et contrat de l'API (`openapi.yaml`). |
| `tests/`, `scripts/` | Tests (navigateur, API, unitaires, budgets, mutations), build, outils de mesure. |
| `scripts/garages/` | **Construction de la table de garages** (tuiles tirées d'Overture Maps, lecture par la page à côté d'OpenStreetMap) : `build.py`, tests, exclusions. Dans `main`, en ligne pour la Haute-Garonne : `docs/exploitation.md`, section 8. |
| `Dockerfile` | Image de l'API seule. |
| `original.html` | Version d'origine, inchangée, pour comparaison. |

## Démarrer

```sh
npm ci
npm run build          # produit index.html et dist/ à partir de src/
npm run dev            # http://localhost:8787 : la page ET l'API, avec une base embarquée (rien à installer)
```

Sans adresse d'API la page garde les réparations dans le navigateur ; `npm run dev` la sert avec l'API et la base, pour essayer le mode partagé.

## Publier

Trois pièces : la **page** (`PIXCAR_API_BASE=https://api.exemple node scripts/build.mjs --only dist --out /tmp/site`, puis publier `/tmp/site/dist/` sur un hébergeur statique ou un CDN), l'**API** (`Dockerfile` ou `node server/index.mjs`, au moins 2 instances) et une base **PostgreSQL ≥ 14** gérée. **Sur AWS** : une seule pile (`infra/pixcar-api.yaml`, API Gateway + Lambda + Aurora DSQL, paquet construit par `npm run build:lambda`), pas à pas dans [docs/exploitation.md](docs/exploitation.md#3-bis-déployer-sur-aws-api-gateway--lambda--aurora-dsql). Pas à pas, réglages, surveillance, incidents et points à valider avant l'ouverture : [docs/exploitation.md](docs/exploitation.md) (dont la publication sur **GitHub Pages avec un domaine personnalisé**, exemple `pixcar.fr`, et ses limites). Une fois l'API en ligne, pour vérifier que les réparations arrivent bien en base : `node scripts/smoke-api.mjs https://api.pixcar.fr --origin https://pixcar.fr`.

## Tester

```sh
npm test                 # suites navigateur (Playwright + Chromium) sur index.html
npm run test:dist        # les mêmes sur dist/, servi avec ses en-têtes (CSP, MIME, compression), + budgets et hors ligne
npm run test:unit        # magasin de réparations, client HTTP, configuration
npm run test:server      # API sur une base embarquée ; TEST_DATABASE_URL=postgres://… : sur un vrai PostgreSQL
TEST_DATABASE_URL=postgres://… node tests/demo-db.js    # démonstration : page → API → PostgreSQL, contenu de la table à chaque étape
node scripts/build.mjs --check    # index.html et dist/ du dépôt correspondent bien aux sources
python scripts/garages/test_garages.py    # construction de la table de garages, sans réseau (pip install -r scripts/garages/requirements.txt)
```

Il faut un Chromium pour Playwright (`npx playwright install chromium`) et `openssl` (la suite `logos` génère un certificat HTTPS de test auto-signé, jamais versionné). Détail des suites, mesures de performance et de charge, et ce qui n'a **pas** pu être vérifié : [docs/tests.md](docs/tests.md).

## Documentation

| Document | Pour |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | Comprendre : pièces, flux d'une déclaration, API, base, confidentialité, disponibilité (matrice des pannes), performances |
| [docs/exploitation.md](docs/exploitation.md) | Mettre en ligne et exploiter : variables, sondes, migrations, modération, effacement, surveillance, incidents, points juridiques |
| [docs/interface.md](docs/interface.md) | Ce que voit le visiteur : mise en page, plusieurs prestations, navigation, charte, avatars, adresses, prix, téléphones, chargement, véhicule ; maintenance du JS |
| [docs/tests.md](docs/tests.md) | Vérifications, mesures, limites |
| [docs/openapi.yaml](docs/openapi.yaml) | Contrat de l'API |

## Ce qui a changé dans cette série

- **Refonte « Orange & Marine » et plusieurs prestations** (**dans `main` et en ligne depuis le 10 octobre 2026**, `gh-pages` `c413594`, construite depuis `903d528` de `main`) : charte orange `#FD5319` et marine `#10121F` (texte marine sur l'orange : 5,7:1), barre de recherche flottante (Où, Prestation, Rayon), panneau de résultats, menus Type / Prix / Enseignes / Plus de filtres au-dessus de la carte, tri dans un menu, nouvelles fiches (tuile colorée selon le type avec la distance et la commune, note ou « Avis », bouton rond d'itinéraire, « Appeler »), sans favori. Fenêtre « **Quelles prestations souhaitez-vous réaliser ?** » : jusqu'à 5 prestations, le contrôle technique seul ; la liste affiche alors le **total** de chaque garage (« Total 2 prestations », ou « Total partiel » s'il manque un prix), le détail par prestation dans la fiche et les repères de l'ensemble à l'accueil. Les données affichées pour une prestation seule sont identiques à avant (vérifié en comparant la suite `func` sur les deux versions). Coût : +8,6 Ko gzip à la première visite. Voir `docs/interface.md`.
- **Table de garages (Overture Maps), dans `main` et en ligne pour la Haute-Garonne seulement** (6 octobre 2026, étape 1 de la mise en ligne par étapes) : des tuiles JSON statiques, construites hors ligne par `scripts/garages/build.py` (Overture sur S3, doublons réunis, lieux fermés retirés d'après le registre SIRENE), jointes au site par `node scripts/build.mjs --garages <dossier>` et lues par la page **en même temps qu'OpenStreetMap** : un garage d'OpenStreetMap n'est complété que de ce qui lui manque (téléphone, site, adresse), un garage absent est ajouté avec la mention « à titre indicatif », et si la table manque la page est celle d'avant. Autour de Cazères (10 km, vraie page, vraies tuiles) : **9 garages → 21, téléphones 5 → 18, sites 4 → 16, 8 Ko par recherche** ; horaires inchangés (la table n'en a pas). Sans l'option, aucun changement. Voir `docs/exploitation.md` (section 8, dont ce qu'il faut faire valider avant l'ouverture : texte de confidentialité modifié, licences), `docs/interface.md`, `docs/architecture.md`.
- **Fond de carte Mapbox** (**en ligne depuis le 10 octobre 2026** : jeton public dans `src/mapbox.json`, lu par la seule version `--pages`) : tuiles Mapbox de 512 px à la place du Plan IGN, repli automatique sur l'IGN puis CARTO si Mapbox refuse ; jeton public seulement, à restreindre à `pixcar.fr` dans le compte Mapbox ; crédit sur la carte et texte de confidentialité adaptés. Les garages viennent toujours d'OpenStreetMap (voir `docs/interface.md`, « Fond de carte (Mapbox) »).
- **Fiches complétées par Mapbox** (dans `main` depuis le 6 octobre 2026, **en ligne depuis le 10 octobre 2026**, réglage `map`) : à l'ouverture d'une fiche de garage dont le téléphone, les horaires ou le site manquent, une requête Mapbox (Search Box, zone de 150 m) cherche le lieu de même nom au même endroit et complète **ce qui manque seulement**, avec la mention « Mapbox ». La liste des garages reste celle d'OpenStreetMap et du registre INSEE. Une requête par garage et par visite au plus (40 au plus), rien conservé, actif avec un jeton Mapbox seulement (réglage `enrich` de `src/mapbox.json` : `map` par défaut, `always`, `off`). Voir `docs/interface.md`, « Fiches complétées par Mapbox ».
- **Mesure d'audience Google Analytics, avec consentement** (dans `main` et publiée sur `pixcar.fr` depuis le 5 octobre 2026) : bandeau « Refuser / Accepter » de même poids ; rien n'est envoyé ni déposé avant l'accord, retrait possible, choix gardé six mois ; seulement dans la version publiée (identifiant de `src/analytics.json`) ; texte de confidentialité et politique de sécurité adaptés (voir `docs/interface.md`, « Mesure d'audience »).
- **La ville dans la puce distance des cartes** (« 2,5 km · Bron ») : lue dans les balises OpenStreetMap, l'adresse ou, pour un garage qui n'a ni l'un ni l'autre, demandée à la Base Adresse Nationale pour les cartes qui entrent à l'écran (voir `docs/interface.md`).
- **Nouvelle police : Outfit** (licence libre OFL, fichiers officiels de Google Fonts hébergés avec le site), à la place de Plus Jakarta Sans ; grossie de 8 % pour garder la taille et les retours à la ligne d'origine, tous les champs de formulaire en héritent (voir `docs/interface.md`, « Typographie »).
- **L'onglet « Mes réparations » est supprimé** : sans session utilisateur, il n'y avait rien à y gérer. Une réparation déclarée met à jour l'onglet « Garages » (échelle de prix, note, historique du garage) ; elle s'annule tout de suite (« Annuler ») ou se supprime depuis l'historique de la fiche.
- **Les réparations vont en base** quand la page est construite avec l'adresse d'une API : partagées par zone, avec file d'envoi hors ligne, envois rejouables sans risque, plaque conservée uniquement sous forme d'empreinte, commentaire jamais publié, relecture des prix aberrants, effacement à la demande.
- **Performances et disponibilité** : première visite d'une centaine de Ko, aucune ressource tierce avant l'affichage, service worker (la page s'ouvre hors ligne et quand l'hébergeur est en panne), caches à tous les étages, API sans état avec copies de secours, arrêt propre, retours arrière simples. Chaque panne retire une fonction sans jamais retirer la page : [matrice des pannes](docs/architecture.md#que-se-passe-t-il-quand-).
