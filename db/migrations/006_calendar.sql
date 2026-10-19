-- Calendrier avancé (docs/calendrier-avance.md, lot 3a) : mécaniciens, compétences, postes et équipements, exigences des prestations,
-- absences et maintenances, affectations des rendez-vous, interventions, historique. Le mode simple (005_rdv.sql) reste tel quel : aucune
-- table existante n'est modifiée. Mêmes règles de portabilité que 001_init.sql (PostgreSQL, PGlite, Aurora DSQL) : pas de clé étrangère,
-- une contrainte CHECK ne regarde qu'une colonne ; les contrôles entre colonnes sont faits par l'API (src/js/shared/plan.js).

-- Réglages du calendrier : une ligne, créée à l'ouverture de l'assistant. Délai minimum, horizon, pas des horaires et jours fériés
-- restent dans rdv_settings (communs aux deux modes).
CREATE TABLE rdv_calendar (
  garage_id     text PRIMARY KEY CHECK (char_length(garage_id) BETWEEN 8 AND 40),
  mode          text NOT NULL DEFAULT 'simple' CHECK (mode IN ('simple', 'advanced')),
  step          smallint NOT NULL DEFAULT 0 CHECK (step BETWEEN 0 AND 6),                              -- dernière étape de l'assistant enregistrée
  reception_min smallint NOT NULL DEFAULT 10 CHECK (reception_min BETWEEN 0 AND 60 AND reception_min % 5 = 0),   -- accueil du véhicule avant les travaux
  return_min    smallint NOT NULL DEFAULT 15 CHECK (return_min BETWEEN 0 AND 60 AND return_min % 5 = 0),         -- véhicule prêt → restitution
  load_pct      smallint NOT NULL DEFAULT 100 CHECK (load_pct BETWEEN 50 AND 100 AND load_pct % 5 = 0),          -- part de la capacité ouverte en ligne
  max_day       smallint NOT NULL DEFAULT 0 CHECK (max_day BETWEEN 0 AND 50),                          -- rendez-vous en ligne par jour (0 : sans limite)
  auto_assign   boolean NOT NULL DEFAULT true,                                                         -- affectation des mécaniciens : sinon « proposée »
  activated_at  timestamptz,
  account_id    text NOT NULL CHECK (char_length(account_id) BETWEEN 1 AND 128),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Mécaniciens (des ressources, pas des comptes). hours : semaine type propre (format de pro_profiles.hours), vide = celle du garage ;
-- services : prestations autorisées, vide = toutes. 30 au plus par garage (contrôlé par l'API).
CREATE TABLE rdv_staff (
  id         uuid PRIMARY KEY,
  garage_id  text NOT NULL CHECK (char_length(garage_id) BETWEEN 8 AND 40),
  name       text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 60),
  active     boolean NOT NULL DEFAULT true,
  hours      jsonb,
  services   jsonb,
  position   smallint NOT NULL DEFAULT 0 CHECK (position BETWEEN 0 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rdv_staff_garage_idx ON rdv_staff (garage_id);

-- Compétences et habilitations d'un garage (cert : habilitation, avec une date de fin de validité par mécanicien).
CREATE TABLE rdv_skills (
  id         uuid PRIMARY KEY,
  garage_id  text NOT NULL CHECK (char_length(garage_id) BETWEEN 8 AND 40),
  label      text NOT NULL CHECK (char_length(label) BETWEEN 2 AND 50),
  cert       boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rdv_skills_garage_idx ON rdv_skills (garage_id);

CREATE TABLE rdv_staff_skills (
  garage_id  text NOT NULL CHECK (char_length(garage_id) BETWEEN 8 AND 40),
  staff_id   uuid NOT NULL,
  skill_id   uuid NOT NULL,
  until      date,                                                                                     -- fin de validité ; vide : sans fin
  PRIMARY KEY (staff_id, skill_id)
);
CREATE INDEX rdv_staff_skills_garage_idx ON rdv_staff_skills (garage_id);

-- Postes et équipements, tous exclusifs (deux places = deux lignes). active : disponible ; hours : heures d'utilisation propres, vide =
-- celles du garage ; services : prestations compatibles, vide = toutes celles qui demandent ce type.
CREATE TABLE rdv_resources (
  id         uuid PRIMARY KEY,
  garage_id  text NOT NULL CHECK (char_length(garage_id) BETWEEN 8 AND 40),
  name       text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  type       text NOT NULL CHECK (type IN ('lift', 'quick', 'tyre', 'diag', 'align', 'clim', 'other')),
  active     boolean NOT NULL DEFAULT true,
  hours      jsonb,
  services   jsonb,
  position   smallint NOT NULL DEFAULT 0 CHECK (position BETWEEN 0 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rdv_resources_garage_idx ON rdv_resources (garage_id);

-- Ce que demande une prestation dans ce garage. Durées en minutes : main-d'œuvre (labour), dont temps commun (shared, compté une fois
-- quand plusieurs prestations se font ensemble), immobilisation du poste (immob ≥ labour), marge après la fin. stations : types de poste
-- possibles (vide : sans poste) ; tools : équipements en plus, pendant la main-d'œuvre ; vehicles : { "suv": { "labour": 75, "immob": 90 } }.
CREATE TABLE rdv_service_reqs (
  garage_id  text NOT NULL CHECK (char_length(garage_id) BETWEEN 8 AND 40),
  service_id text NOT NULL CHECK (char_length(service_id) BETWEEN 2 AND 40),
  online     boolean NOT NULL DEFAULT true,
  labour_min smallint NOT NULL CHECK (labour_min BETWEEN 5 AND 600 AND labour_min % 5 = 0),
  shared_min smallint NOT NULL DEFAULT 0 CHECK (shared_min BETWEEN 0 AND 120 AND shared_min % 5 = 0),
  immob_min  smallint NOT NULL CHECK (immob_min BETWEEN 5 AND 720 AND immob_min % 5 = 0),
  staff_n    smallint NOT NULL DEFAULT 1 CHECK (staff_n BETWEEN 1 AND 3),
  skills     jsonb NOT NULL DEFAULT '[]',
  stations   jsonb NOT NULL DEFAULT '[]',
  tools      jsonb NOT NULL DEFAULT '[]',
  margin_min smallint NOT NULL DEFAULT 0 CHECK (margin_min BETWEEN 0 AND 60 AND margin_min % 5 = 0),
  auto       boolean NOT NULL DEFAULT false,                                                         -- confirmation automatique
  parts      boolean NOT NULL DEFAULT false,                                                         -- pièces à vérifier avant de confirmer
  parts_h    smallint NOT NULL DEFAULT 0 CHECK (parts_h IN (0, 24, 48, 72, 120, 168)),              -- délai de commande des pièces
  drop_off   boolean NOT NULL DEFAULT false,                                                         -- le client laisse sa voiture
  vehicles   jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (garage_id, service_id)
);

-- Absences des mécaniciens, maintenances et pannes des postes (à l'heure près). Les fermetures du garage restent dans rdv_closures.
CREATE TABLE rdv_unavail (
  id         uuid PRIMARY KEY,
  garage_id  text NOT NULL CHECK (char_length(garage_id) BETWEEN 8 AND 40),
  target     text NOT NULL CHECK (target IN ('staff', 'resource')),
  target_id  uuid NOT NULL,
  starts_at  timestamptz NOT NULL,
  ends_at    timestamptz NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('absence', 'leave', 'training', 'maintenance', 'breakdown', 'other')),
  label      text NOT NULL DEFAULT '' CHECK (char_length(label) <= 60),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rdv_unavail_garage_idx ON rdv_unavail (garage_id, ends_at);

-- Affectations (ResourceBookings) : une ligne par mécanicien et par segment de main-d'œuvre (role labour), une par poste occupé (station),
-- une par équipement (tool). Elles ne retiennent la ressource que tant que la demande la retient (en attente avant l'heure limite, ou
-- confirmée) ; elles sont supprimées quand la demande se termine (refus, expiration, annulation). block_id : bloc interne (lot 3b).
-- fixed : choisie à la main par le garage, jamais recalculée.
CREATE TABLE rdv_assignments (
  id         uuid PRIMARY KEY,
  garage_id  text NOT NULL CHECK (char_length(garage_id) BETWEEN 8 AND 40),
  request_id uuid,
  block_id   uuid,
  target     text NOT NULL CHECK (target IN ('staff', 'resource')),
  target_id  uuid NOT NULL,
  role       text NOT NULL CHECK (role IN ('labour', 'station', 'tool')),
  day        date NOT NULL,
  starts_at  timestamptz NOT NULL,
  ends_at    timestamptz NOT NULL,
  fixed      boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rdv_assignments_garage_day_idx ON rdv_assignments (garage_id, day);
CREATE INDEX rdv_assignments_request_idx ON rdv_assignments (request_id);
CREATE INDEX rdv_assignments_target_idx ON rdv_assignments (target_id, starts_at);

-- Intervention liée à un rendez-vous du mode avancé (une par rendez-vous, créée avec la demande). Statuts d'atelier : lot 3c.
CREATE TABLE rdv_work_orders (
  request_id uuid PRIMARY KEY,
  garage_id  text NOT NULL CHECK (char_length(garage_id) BETWEEN 8 AND 40),
  status     text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'received', 'in_progress', 'waiting_parts', 'suspended', 'done', 'returned')),
  vehicle    text NOT NULL DEFAULT '' CHECK (vehicle IN ('', 'city', 'compact', 'sedan', 'suv', 'van')),
  work_start timestamptz,                                                                               -- début des travaux
  work_end   timestamptz,                                                                               -- fin de la main-d'œuvre
  ready_at   timestamptz,                                                                               -- véhicule prêt (fin de l'immobilisation)
  return_at  timestamptz,                                                                               -- restitution prévue
  labour_min smallint CHECK (labour_min BETWEEN 0 AND 2400),
  immob_min  smallint CHECK (immob_min BETWEEN 0 AND 2400),
  no_show_at timestamptz,                                                                               -- client absent (lot 3c)
  status_at  timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rdv_work_orders_garage_idx ON rdv_work_orders (garage_id, work_start);

-- Historique des changements importants (mode, fiches, absences, affectations, déplacements). Jamais de donnée de client. 12 mois.
CREATE TABLE rdv_history (
  id         uuid PRIMARY KEY,
  garage_id  text NOT NULL CHECK (char_length(garage_id) BETWEEN 8 AND 40),
  at         timestamptz NOT NULL DEFAULT now(),
  account_id text NOT NULL DEFAULT '' CHECK (char_length(account_id) <= 128),
  what       text NOT NULL CHECK (char_length(what) BETWEEN 2 AND 20),
  ref_id     uuid,
  detail     text NOT NULL DEFAULT '' CHECK (char_length(detail) <= 300)
);
CREATE INDEX rdv_history_garage_idx ON rdv_history (garage_id, at);
CREATE INDEX rdv_history_at_idx ON rdv_history (at);
