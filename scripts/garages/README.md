# Table de garages (tuiles Overture)

Construit les tuiles statiques que la page charge à côté d'OpenStreetMap : `python scripts/garages/build.py --help`.

| Fichier | Rôle |
|---|---|
| `build.py` | orchestre : zone → lecture d'Overture → mise en forme → exclusions → doublons → lieux fermés → écriture → contrôle |
| `overture.py` | lecture d'Overture sur S3 par plages d'octets (seuls les groupes de lignes de la zone sont téléchargés) |
| `sirene.py` | établissements du registre (API Recherche d'entreprises) : sert à écarter les lieux fermés, rien n'en est publié |
| `tiles.py` | format des tuiles, nettoyage, doublons, filtre des fermés, écriture déterministe, contrôle (`validate_dir`) |
| `matching.py` | même règle de rapprochement que `src/js/modules/garages-table.js` (comparées par `diff_js.mjs`) |
| `exclusions.json` | identifiants Overture à ne jamais publier (demande d'un professionnel) : aucun nom ni numéro dedans |
| `diff_js.mjs` | calcule avec le module JavaScript de la page ce que `matching.py` calcule : `test_garages.py` compare |
| `test_garages.py` | tests sans réseau (`python scripts/garages/test_garages.py` : 111 contrôles, dont la comparaison avec le module JavaScript) ; variantes : `python tests/mutation/mut_garages.py --python` |

Dépendances : `pip install -r scripts/garages/requirements.txt`. Le détail du format, de l'exploitation et des précautions (légal, exclusions, calendrier mensuel) : `docs/exploitation.md`, section 8. Workflow : `.github/workflows/garages.yml` (déclenchement manuel ; ne publie rien). Une fois les tuiles construites : `node scripts/build.mjs --only dist --out /tmp/site --pages pixcar.fr --garages build/garages`.
