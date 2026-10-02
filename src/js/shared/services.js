// Les prestations que la page propose, avec leurs balises OpenStreetMap et leur aide : une seule définition, partagée par la
// page, le build (liste des prestations écrite dans le HTML) et l'API (prestations déclarables).
//   id    : identifiant stable (enregistré en base : ne jamais le renommer)
//   g     : groupe d'affichage · label : libellé · kind : « ct » (prix officiels), « geo », « tyre », « mech »
//   osm   : balises « service:vehicle:* » d'OpenStreetMap qui annoncent la prestation · hint : aide sous la liste
const ALIGN = ["wheel_alignment", "alignment"];

export const SERVICES = [
  {
    id: "geo_av",
    g: "Pneus et géométrie",
    label: "Parallélisme / géométrie avant",
    kind: "geo",
    osm: ALIGN,
    hint: "Contrôle et réglage du train avant. Utile après un choc contre un trottoir, si la voiture tire d'un côté ou si les pneus s'usent de travers.",
  },
  {
    id: "geo_4",
    g: "Pneus et géométrie",
    label: "Géométrie avant + arrière",
    kind: "geo",
    osm: ALIGN,
    hint: "Réglage des quatre roues : surtout pour les SUV, 4x4 et propulsions, ou après un choc à l'arrière.",
  },
  {
    id: "geo_ctrl",
    g: "Pneus et géométrie",
    label: "Contrôle de géométrie (sans réglage)",
    kind: "geo",
    osm: ALIGN,
    hint: "Mesure seule. Chez plusieurs enseignes, ce prix est déduit si un réglage suit.",
  },
  {
    id: "montage",
    g: "Pneus et géométrie",
    label: "Montage et équilibrage d'un pneu",
    kind: "tyre",
    unit: "par pneu",
    osm: ["tyres"],
    hint: "Prix par pneu, sans le pneu lui-même.",
  },
  {
    id: "equil",
    g: "Pneus et géométrie",
    label: "Équilibrage d'une roue",
    kind: "tyre",
    unit: "par roue",
    osm: ["tyres"],
    hint: "Contre les vibrations dans le volant à vitesse stabilisée.",
  },
  {
    id: "crevaison",
    g: "Pneus et géométrie",
    label: "Réparation de crevaison",
    kind: "tyre",
    unit: "par pneu",
    osm: ["tyres"],
    hint: "Possible si le trou est sur la bande de roulement et si le pneu n'a pas roulé à plat.",
  },
  {
    id: "vidange",
    g: "Entretien",
    label: "Vidange (huile + filtre)",
    kind: "mech",
    osm: ["oil_change"],
    hint: "Le prix dépend de l'huile préconisée pour votre moteur.",
  },
  {
    id: "revision",
    g: "Entretien",
    label: "Révision constructeur",
    kind: "mech",
    osm: ["oil_change"],
    hint: "Suit le carnet d'entretien : le prix dépend du modèle et du kilométrage, sur devis.",
  },
  {
    id: "clim",
    g: "Entretien",
    label: "Recharge de climatisation",
    kind: "mech",
    osm: ["air_conditioning"],
    hint: "Les voitures récentes au gaz R1234yf coûtent plus cher à recharger.",
  },
  {
    id: "diag",
    g: "Entretien",
    label: "Diagnostic électronique (voyant allumé)",
    kind: "mech",
    osm: ["diagnostics", "electrical"],
    hint: "Lecture des codes défauts et interprétation par un technicien.",
  },
  {
    id: "batterie",
    g: "Entretien",
    label: "Remplacement de batterie",
    kind: "mech",
    osm: ["batteries"],
    hint: "La pose est souvent offerte si la batterie est achetée sur place.",
  },
  {
    id: "plaq_av",
    g: "Freinage",
    label: "Plaquettes de frein avant",
    kind: "mech",
    osm: ["brakes"],
    hint: "Pièces et pose, essieu avant.",
  },
  {
    id: "disq_av",
    g: "Freinage",
    label: "Disques et plaquettes avant",
    kind: "mech",
    osm: ["brakes"],
    hint: "Le prix dépend du modèle : sur devis.",
  },
  {
    id: "liq_frein",
    g: "Freinage",
    label: "Remplacement du liquide de frein",
    kind: "mech",
    osm: ["brakes"],
    hint: "Conseillé environ tous les deux ans.",
  },
  {
    id: "amortisseurs",
    g: "Suspension et moteur",
    label: "Amortisseurs avant",
    kind: "mech",
    osm: ["suspension", "shock_absorbers"],
    hint: "Le prix dépend du modèle : sur devis.",
  },
  {
    id: "distribution",
    g: "Suspension et moteur",
    label: "Courroie de distribution",
    kind: "mech",
    osm: ["engine"],
    hint: "Intervention lourde : comparez au moins trois devis.",
  },
  {
    id: "embrayage",
    g: "Suspension et moteur",
    label: "Embrayage",
    kind: "mech",
    osm: ["clutch", "transmission"],
    hint: "Intervention lourde : comparez au moins trois devis.",
  },
  {
    id: "ct",
    g: "Contrôle technique",
    label: "Contrôle technique (prix officiels)",
    kind: "ct",
    hint: "Prix déclarés par chaque centre agréé, publiés par la DGCCRF et mis à jour chaque jour.",
  },
];

// Réparations qu'un visiteur peut déclarer : toutes sauf le contrôle technique (ses prix sont officiels), plus « autre ».
export const OTHER_SERVICE = "autre";
export const REPAIR_SERVICES = [...SERVICES.filter((s) => s.kind !== "ct").map((s) => s.id), OTHER_SERVICE];
