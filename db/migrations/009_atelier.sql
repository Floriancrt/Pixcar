-- Gestion d'atelier, P0 (docs/gestion-atelier.md, 4) : rendez-vous saisis par le garage dans les deux calculs des disponibilités,
-- modules de l'affichage avancé, affichage choisi par compte. Des colonnes ajoutées seulement, nullables et sans défaut ni contrainte
-- (Aurora DSQL : ALTER TABLE … ADD COLUMN n'accepte ni l'un ni l'autre) ; les valeurs sont contrôlées par l'API
-- (src/js/shared/plan.js parseBlock, src/js/shared/work.js parsePrefs et parseModules). « IF NOT EXISTS » : relançable sur DSQL,
-- où chaque instruction est sa propre transaction (server/migrate.mjs).
--
-- rdv_blocks, rendez-vous saisis (kind « job ») :
--   slot_id  créneau de la semaine type qui le compte (calcul par créneaux), null hors de tout créneau ou en calcul par ressources
--   channel  origine : phone, walkin, other (null : phone, comme avant)
--   minutes  durée estimée des travaux : ce qu'il occupe dans son créneau (end_min reste la restitution prévue)
--   car, plate, phone, note   véhicule, immatriculation, téléphone du client, commentaire interne : effacés avec le libellé
--                             30 jours après le jour (Pixcar sous-traitant du garage, docs/gestion-atelier.md 2.8)
-- Un créneau bloqué (kind « hold ») sans affectation vaut pour tout l'atelier.
ALTER TABLE rdv_blocks ADD COLUMN IF NOT EXISTS slot_id uuid;
ALTER TABLE rdv_blocks ADD COLUMN IF NOT EXISTS channel text;
ALTER TABLE rdv_blocks ADD COLUMN IF NOT EXISTS minutes smallint;
ALTER TABLE rdv_blocks ADD COLUMN IF NOT EXISTS car text;
ALTER TABLE rdv_blocks ADD COLUMN IF NOT EXISTS plate text;
ALTER TABLE rdv_blocks ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE rdv_blocks ADD COLUMN IF NOT EXISTS note text;
-- modules de l'affichage avancé, pour tout le garage : { staff, equip, track, load } (null : tous actifs)
ALTER TABLE rdv_settings ADD COLUMN IF NOT EXISTS modules jsonb;
-- affichage de Gestion d'atelier choisi par ce compte : simple ou advanced (null : d'après le calcul des disponibilités)
ALTER TABLE pro_prefs ADD COLUMN IF NOT EXISTS view text;
