#!/usr/bin/env bash
# Déploie l'API Pixcar depuis AWS CloudShell, en une commande (docs/exploitation.md, « Déployer l'API depuis CloudShell ») :
#   curl -fsSL https://raw.githubusercontent.com/Floriancrt/Pixcar/main/scripts/cloudshell-deploy.sh | bash
# À lancer dans la console AWS du compte de l'API, région eu-north-1 : les droits sont ceux de la personne connectée, rien n'est
# installé dans le compte, aucune clé n'est stockée nulle part.
# Étapes : vérification du compte et de la pile ; Node.js 22 (téléchargé et vérifié si CloudShell en a un plus ancien) ; code de main
# (dépôt public) ; dépendances ; tests unitaires et serveur ; paquet construit deux fois ; puis scripts/deploy-api.mjs deploy :
# modèle de la pile mis à jour la première fois, fonction d'opérations, migration, auto-contrôle, API, essai de bout en bout, retour
# arrière automatique. Rien n'est déployé si un test échoue. Le résumé est gardé dans ~/pixcar-dernier-deploiement.md.
# Réglages (variables d'environnement) : PIXCAR_REF (branche ou étiquette, main par défaut), PIXCAR_STACK (pixcar),
# PIXCAR_REGION (eu-north-1), PIXCAR_DRY_RUN=1 (tout sauf AWS : code, tests, paquet ; sert à essayer le script).
set -euo pipefail

# Tout le script est dans une fonction : avec « curl … | bash », bash le lit en entier avant d'exécuter quoi que ce soit, et aucune
# commande (npm, node…) ne peut avaler la suite du script par l'entrée standard.
main() {
  local repo="https://github.com/Floriancrt/Pixcar.git"
  local ref="${PIXCAR_REF:-main}" stack="${PIXCAR_STACK:-pixcar}" region="${PIXCAR_REGION:-eu-north-1}" dry="${PIXCAR_DRY_RUN:-}"
  local node_version="22.22.0"
  local work
  work="$(mktemp -d "${TMPDIR:-/tmp}/pixcar-deploy.XXXXXX")"
  trap 'rm -rf "$work"' EXIT

  step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
  fail() { printf '\n\033[31mARRÊT : %s\033[0m\n' "$*" >&2; exit 1; }
  quiet() { # lance une commande, ne montre sa sortie qu'en cas d'échec (les 80 dernières lignes)
    local log="$work/log.txt"
    if ! "$@" >"$log" 2>&1 </dev/null; then
      tail -n 80 "$log" >&2
      return 1
    fi
  }

  for tool in git curl tar sha256sum; do command -v "$tool" >/dev/null || fail "$tool introuvable (script prévu pour AWS CloudShell)"; done

  if [ -z "$dry" ]; then
    step "Compte AWS"
    command -v aws >/dev/null || fail "ligne de commande aws introuvable (script prévu pour AWS CloudShell)"
    local account status
    account="$(aws sts get-caller-identity --query Account --output text </dev/null)" || fail "pas d'identifiants AWS : lancer ce script dans CloudShell"
    status="$(aws cloudformation describe-stacks --stack-name "$stack" --region "$region" --query 'Stacks[0].StackStatus' --output text </dev/null 2>/dev/null)" ||
      fail "pile $stack introuvable dans $region (compte $account) : bon compte ? bonne région ?"
    echo "compte $account, pile $stack ($region) : $status"
  fi

  step "Node.js 22"
  local major=0
  if command -v node >/dev/null; then major="$(node -p 'process.versions.node.split(".")[0]' </dev/null)"; fi
  if [ "$major" -lt 22 ]; then
    local arch name base="https://nodejs.org/dist/v$node_version"
    case "$(uname -m)" in x86_64) arch=x64 ;; aarch64 | arm64) arch=arm64 ;; *) fail "processeur $(uname -m) non prévu" ;; esac
    name="node-v$node_version-linux-$arch"
    echo "Node.js $major trouvé : téléchargement de $name (nodejs.org, empreinte vérifiée)"
    curl -fsSLo "$work/$name.tar.xz" "$base/$name.tar.xz" || fail "téléchargement de Node.js impossible"
    curl -fsSLo "$work/SHASUMS256.txt" "$base/SHASUMS256.txt" || fail "téléchargement des empreintes de Node.js impossible"
    (cd "$work" && grep " $name.tar.xz\$" SHASUMS256.txt | sha256sum -c --quiet -) || fail "empreinte de Node.js incorrecte : rien n'est lancé"
    tar -xJf "$work/$name.tar.xz" -C "$work"
    export PATH="$work/$name/bin:$PATH"
  fi
  echo "node $(node --version </dev/null), npm $(npm --version </dev/null)"

  step "Code ($ref)"
  git clone --quiet --depth 1 --branch "$ref" "$repo" "$work/pixcar" </dev/null || fail "impossible de récupérer $ref depuis $repo"
  cd "$work/pixcar"
  echo "commit $(git rev-parse --short HEAD) — $(git log -1 --format='%s (%cd)' --date=short)"

  step "Dépendances"
  export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 # pas de navigateur : les suites du navigateur ne tournent pas ici
  quiet npm ci --no-audit --no-fund || fail "installation des dépendances en échec"
  echo "ok"

  step "Tests unitaires et serveur (une à trois minutes)"
  quiet npm run -s test:unit || fail "tests unitaires en échec : rien n'est déployé"
  echo "unitaires : ok"
  quiet npm run -s test:server || fail "tests serveur en échec : rien n'est déployé"
  echo "serveur : ok"

  step "Paquet"
  node scripts/deploy-api.mjs package --out dist-lambda </dev/null | tee "$work/package.txt"
  local file
  file="$(sed -n 's/^\(pixcar-lambda-[0-9a-f]*\.zip\).*/\1/p' "$work/package.txt" | head -n 1)"
  [ -n "$file" ] || fail "paquet introuvable"

  if [ -n "$dry" ]; then
    step "Essai à blanc (PIXCAR_DRY_RUN) : rien n'est déployé"
    echo "node scripts/deploy-api.mjs deploy --zip dist-lambda/$file --stack $stack --region $region --template infra/pixcar-api.yaml"
    return 0
  fi

  step "Déploiement"
  local code=0
  node scripts/deploy-api.mjs deploy --zip "dist-lambda/$file" --stack "$stack" --region "$region" --template infra/pixcar-api.yaml --summary "$work/resume.md" </dev/null || code=$?
  if [ -f "$work/resume.md" ]; then
    cp "$work/resume.md" "$HOME/pixcar-dernier-deploiement.md"
    step "Résumé (gardé dans ~/pixcar-dernier-deploiement.md)"
    cat "$work/resume.md"
  fi
  return "$code"
}

main "$@"
