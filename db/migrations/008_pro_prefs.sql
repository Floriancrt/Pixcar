-- Espace Pro, lot 3c (docs/calendrier-avance.md, « Lot 3c ») : préférences d'un compte pour un garage (raccourcis du tableau de bord).
-- Une nouvelle table seulement ; mêmes règles de portabilité que 001_init.sql (PostgreSQL, PGlite, Aurora DSQL) : pas de clé étrangère.
-- Aucune donnée personnelle : des identifiants d'écrans. Effacées avec le rattachement (pro-revoke).
-- Le suivi des interventions du lot 3c n'ajoute rien : rdv_work_orders a ses états depuis 006 (status, status_at, no_show_at).
CREATE TABLE pro_prefs (
  garage_id  text NOT NULL CHECK (char_length(garage_id) BETWEEN 8 AND 40),
  account_id text NOT NULL CHECK (char_length(account_id) BETWEEN 1 AND 128),
  shortcuts  jsonb NOT NULL DEFAULT '[]',                                              -- ["planning", "prices", …], six au plus
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (garage_id, account_id)
);
