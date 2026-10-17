-- Espace Pro, « Mon garage » : ce qu'un garage vérifié déclare de lui-même (coordonnées, horaires) et les prestations qu'il fait, avec leur
-- temps moyen (privé : il servira au calcul des horaires de rendez-vous, jamais montré aux automobilistes). Voir docs/rendez-vous.md.
-- Mêmes règles de portabilité que 001_init.sql (PostgreSQL, PGlite, Aurora DSQL) : pas de clé étrangère.

-- Le profil publié d'un garage : une ligne, créée au premier enregistrement. Nom, adresse et téléphone n'y arrivent qu'une fois un
-- changement relu par Pixcar (pro_profile_changes) ; site, e-mail affiché et horaires y sont écrits directement par le garage.
CREATE TABLE pro_profiles (
  garage_id  text PRIMARY KEY CHECK (char_length(garage_id) BETWEEN 8 AND 40),     -- identifiant Overture (celui de garage_contacts)
  name       text NOT NULL DEFAULT '' CHECK (char_length(name) <= 120),           -- vide : le nom des données publiques
  street     text NOT NULL DEFAULT '' CHECK (char_length(street) <= 200),
  pc         text NOT NULL DEFAULT '' CHECK (char_length(pc) IN (0, 5)),
  city       text NOT NULL DEFAULT '' CHECK (char_length(city) <= 80),
  phone      text NOT NULL DEFAULT '' CHECK (char_length(phone) <= 16),           -- format international (+33…)
  website    text NOT NULL DEFAULT '' CHECK (char_length(website) <= 200),
  email      text NOT NULL DEFAULT '' CHECK (char_length(email) <= 254),          -- e-mail affiché aux clients
  hours      jsonb,                                                               -- { "mo": [["08:00","12:00"], …], … } ; vide : non déclarés
  account_id text NOT NULL CHECK (char_length(account_id) BETWEEN 1 AND 128),     -- compte qui l'a modifié en dernier
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Changements de nom, d'adresse ou de téléphone, relus par Pixcar avant publication (op « pro-change »). Un seul en attente par garage et
-- par champ : une nouvelle demande remplace la précédente. Décidés ou annulés : effacés après 90 jours.
CREATE TABLE pro_profile_changes (
  id         uuid PRIMARY KEY,
  garage_id  text NOT NULL CHECK (char_length(garage_id) BETWEEN 8 AND 40),
  field      text NOT NULL CHECK (field IN ('name', 'addr', 'phone')),
  value      text NOT NULL CHECK (char_length(value) BETWEEN 1 AND 400),          -- adresse : JSON { street, pc, city }
  status     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  account_id text NOT NULL CHECK (char_length(account_id) BETWEEN 1 AND 128),
  reason     text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 300),         -- motif d'un refus, montré au garagiste
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);
CREATE UNIQUE INDEX pro_profile_changes_one_pending_idx ON pro_profile_changes (garage_id, field) WHERE status = 'pending';
CREATE INDEX pro_profile_changes_garage_idx ON pro_profile_changes (garage_id, created_at);
CREATE INDEX pro_profile_changes_status_idx ON pro_profile_changes (status, created_at);

-- Les prestations qu'un garage dit faire (ou ne pas faire), et leur temps moyen d'atelier pour une voiture courante (par pneu ou par
-- roue quand la prestation a une unité). Pas de ligne : le garage n'a rien dit.
CREATE TABLE pro_services (
  garage_id  text NOT NULL CHECK (char_length(garage_id) BETWEEN 8 AND 40),
  service_id text NOT NULL CHECK (char_length(service_id) BETWEEN 2 AND 40),
  offered    boolean NOT NULL,
  minutes    smallint CHECK (minutes BETWEEN 15 AND 480 AND minutes % 15 = 0),   -- vide : à saisir
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (garage_id, service_id)
);
