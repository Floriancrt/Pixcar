-- Calendrier avancé, lot 3b (docs/calendrier-avance.md, « Lot 3b ») : blocs internes du planning. Une nouvelle table seulement (sur
-- Aurora DSQL, ALTER TABLE ne peut pas ajouter de colonne avec défaut ni de contrainte) ; mêmes règles de portabilité que 006.
--
-- kind « job » : rendez-vous pris hors Pixcar (téléphone, comptoir) : libellé, prestations, type de véhicule, planifié par le moteur
-- comme une demande ; kind « hold » : créneau bloqué sur des mécaniciens ou des postes (réunion, livraison…). Les ressources occupées
-- sont dans rdv_assignments (block_id). starts_at : dépôt (job) ou début (hold) ; ends_at : restitution prévue (job) ou fin (hold).
-- Conservation comme les demandes : libellé effacé 30 jours après le jour (anonymized_at), ligne effacée après 24 mois.
CREATE TABLE rdv_blocks (
  id            uuid PRIMARY KEY,
  garage_id     text NOT NULL CHECK (char_length(garage_id) BETWEEN 8 AND 40),
  kind          text NOT NULL CHECK (kind IN ('job', 'hold')),
  label         text NOT NULL DEFAULT '' CHECK (char_length(label) <= 40),
  services      jsonb NOT NULL DEFAULT '[]',                                                         -- [{ id, qty }] (job)
  vehicle       text NOT NULL DEFAULT '' CHECK (vehicle IN ('', 'city', 'compact', 'sedan', 'suv', 'van')),
  mode          text NOT NULL DEFAULT 'hour' CHECK (mode IN ('hour', 'drop')),
  day           date NOT NULL,
  start_min     smallint NOT NULL CHECK (start_min BETWEEN 0 AND 1439),
  end_min       smallint NOT NULL CHECK (end_min BETWEEN 1 AND 1440),
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz NOT NULL,
  fixed         boolean NOT NULL DEFAULT false,                                                      -- mécanicien ou poste choisi à la main
  account_id    text NOT NULL DEFAULT '' CHECK (char_length(account_id) <= 128),
  anonymized_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rdv_blocks_garage_day_idx ON rdv_blocks (garage_id, day);
CREATE INDEX rdv_blocks_day_idx ON rdv_blocks (day);
