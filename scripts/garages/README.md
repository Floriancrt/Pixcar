# Table de garages (tuiles Overture)

Construit les tuiles statiques que la page charge à côté d'OpenStreetMap : `python scripts/garages/build.py --help`.

| Fichier | Rôle |
|---|---|
| `build.py` | orchestre : zone → lecture d'Overture → mise en forme → exclusions → doublons → lieux fermés → écriture → contrôle |
| `overture.py` | lecture d'Overture sur S3 par plages d'octets (seuls les groupes de lignes de la zone sont téléchargés) |
| `sirene.py` | établissements du registre (API Recherche d'entreprises) : sert à écarter les lieux fermés, rien n'en est publié |
| `tiles.py` | format des tuiles, nettoyage, doublons, filtre des fermés, écriture déterministe, contrôle (`validate_dir`) |
| `matching.py` | même règle de rapprochement que `src/js/modules/garages-table.js` (comparées par `diff_js.mjs`) |
| `exclusions.json` | identifiants Overture à ne jamais publier (demande d'un professionnel) |
| `test_garages.py` | tests sans réseau (`python scripts/garages/test_garages.py`) |

Dépendances : `pip install -r scripts/garages/requirements.txt`. Le détail du format, de l'exploitation et des précautions : `docs/exploitation.md`, section 8.
