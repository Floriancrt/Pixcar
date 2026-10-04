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
```

Il faut un Chromium pour Playwright (`npx playwright install chromium`) et `openssl` (la suite `logos` génère un certificat HTTPS de test auto-signé, jamais versionné). Détail des suites, mesures de performance et de charge, et ce qui n'a **pas** pu être vérifié : [docs/tests.md](docs/tests.md).

## Documentation

| Document | Pour |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | Comprendre : pièces, flux d'une déclaration, API, base, confidentialité, disponibilité (matrice des pannes), performances |
| [docs/exploitation.md](docs/exploitation.md) | Mettre en ligne et exploiter : variables, sondes, migrations, modération, effacement, surveillance, incidents, points juridiques |
| [docs/interface.md](docs/interface.md) | Ce que voit le visiteur : navigation, charte, avatars, adresses, prix, téléphones, chargement, véhicule ; maintenance du JS |
| [docs/tests.md](docs/tests.md) | Vérifications, mesures, limites |
| [docs/openapi.yaml](docs/openapi.yaml) | Contrat de l'API |

## Ce qui a changé dans cette série

- **La ville dans la puce distance des cartes** (« 2,5 km · Bron ») : lue dans les balises OpenStreetMap, l'adresse ou, pour un garage qui n'a ni l'un ni l'autre, demandée à la Base Adresse Nationale pour les cartes qui entrent à l'écran (voir `docs/interface.md`).
- **L'onglet « Mes réparations » est supprimé** : sans session utilisateur, il n'y avait rien à y gérer. Une réparation déclarée met à jour l'onglet « Garages » (échelle de prix, note, historique du garage) ; elle s'annule tout de suite (« Annuler ») ou se supprime depuis l'historique de la fiche.
- **Les réparations vont en base** quand la page est construite avec l'adresse d'une API : partagées par zone, avec file d'envoi hors ligne, envois rejouables sans risque, plaque conservée uniquement sous forme d'empreinte, commentaire jamais publié, relecture des prix aberrants, effacement à la demande.
- **Performances et disponibilité** : première visite d'une centaine de Ko, aucune ressource tierce avant l'affichage, service worker (la page s'ouvre hors ligne et quand l'hébergeur est en panne), caches à tous les étages, API sans état avec copies de secours, arrêt propre, retours arrière simples. Chaque panne retire une fonction sans jamais retirer la page : [matrice des pannes](docs/architecture.md#que-se-passe-t-il-quand-).
