"""Tests de mutation : on casse UNE chose dans les sources, on reconstruit la page, et la vérification concernée doit échouer.

Une mutation = (nom, ancre, remplacement, sections, vérification attendue)
  ancre         texte qui doit figurer exactement une fois dans src/ ; sinon « skip » (ancre périmée), compté comme non tuée
  sections      lettres passées à la suite de tests pour ne lancer que ce qui sert
  vérification  préfixe du nom de la vérification qui doit échouer (« FAIL: <nom> » dans la sortie de la suite)

  python3 tests/mutation/mut_ux.py              toutes les mutations de la liste
  python3 tests/mutation/mut_ux.py dès scroll   seulement celles dont le nom contient un de ces mots
  python3 tests/mutation/mut_ux.py --anchors    vérifie seulement que chaque ancre existe encore (sans navigateur)

Rien n'est modifié dans src/ : les sources sont copiées dans .mut/ (ignoré par git), la page est reconstruite à partir
de la copie (scripts/build.mjs --src --out) et testée sous .mut/mut.html.
"""
import os, pathlib, re, shutil, subprocess, sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
SRC = ROOT / "src"
WORK = ROOT / ".mut"
TEXT = {".js", ".css", ".html"}


def run(mutations, suite, name_width):
    args = sys.argv[1:]
    anchors_only = "--anchors" in args
    only = [a for a in args if not a.startswith("--")]
    originals = {p: p.read_text(encoding="utf-8") for p in sorted(SRC.rglob("*")) if p.is_file() and p.suffix in TEXT}
    if not anchors_only:
        shutil.rmtree(WORK, ignore_errors=True)
        shutil.copytree(SRC, WORK / "src")
    bad = 0
    for name, find, rep, secs, must in mutations:
        if only and not any(o.lower() in name.lower() for o in only):
            continue
        hits = [(p, t.count(find)) for p, t in originals.items() if find in t]
        n = sum(c for _, c in hits)
        if n != 1:
            print(f"[skip] {name}: ancre trouvée {n} fois", flush=True)
            bad += 1
            continue
        if anchors_only:
            continue
        path = hits[0][0]
        target = WORK / "src" / path.relative_to(SRC)
        target.write_text(originals[path].replace(find, rep), encoding="utf-8")
        try:
            built = subprocess.run(["node", "scripts/build.mjs", "--src", str(WORK / "src"), "--out", str(WORK / "out"), "--only", "single"], cwd=ROOT, capture_output=True, text=True, timeout=300)
            if built.returncode:
                print(f"[skip] {name}: la page ne se construit plus ({(built.stderr or built.stdout).strip()[:120]})", flush=True)
                bad += 1
                continue
            shutil.copyfile(WORK / "out" / "index.html", WORK / "mut.html")
            r = subprocess.run(["node", f"tests/{suite}", ".mut/mut.html", secs], cwd=ROOT, capture_output=True, text=True, timeout=900)
            fails = re.findall(r"FAIL: (\S+)", r.stdout)
            ok = any(f.startswith(must) for f in fails)
            print(f"[{'tuée' if ok else 'SURVIVANTE'}] {name:{name_width}s} attendu {must:4s} -> échecs : {', '.join(sorted(set(fails))) or 'aucun'}", flush=True)
            bad += not ok
        finally:
            target.write_text(originals[path], encoding="utf-8")
    print("ancres périmées :" if anchors_only else "mutations non tuées :", bad)
    sys.exit(1 if bad else 0)


# ---- mutations sans navigateur : serveur, magasin de réparations, client HTTP (tests node:test) ----------------------------
# Une mutation = (nom, fichier, ancre, remplacement, dossier de tests, filtres de fichiers de tests)
# La variante est vérifiée dans une COPIE minimale du dépôt (.mut/node/) ; elle est « tuée » quand au moins un test échoue
# (et que l'échec n'est pas une erreur de syntaxe ou d'import : une variante qui ne se charge pas ne prouve rien).
NODE_COPY = ["server", "db", "infra", "scripts/node-tests.mjs", "scripts/build-lambda.mjs", "package.json", "tests/unit", "src/js/modules", "src/js/shared", "src/js/package.json"]


def run_node(mutations, name_width):
    args = sys.argv[1:]
    anchors_only = "--anchors" in args
    only = [a for a in args if not a.startswith("--")]
    work = WORK / "node"
    if not anchors_only:
        shutil.rmtree(work, ignore_errors=True)
        for rel in NODE_COPY:
            src, dst = ROOT / rel, work / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(src, dst) if src.is_dir() else shutil.copyfile(src, dst)
        (work / "node_modules").symlink_to(ROOT / "node_modules")
    env = {k: v for k, v in os.environ.items() if k != "TEST_DATABASE_URL"}  # base embarquée : rapide et sans effet de bord
    bad = 0
    for name, rel, find, rep, suite, filters in mutations:
        if only and not any(o.lower() in name.lower() for o in only):
            continue
        original = (ROOT / rel).read_text(encoding="utf-8")
        n = original.count(find)
        if n != 1:
            print(f"[skip] {name}: ancre trouvée {n} fois dans {rel}", flush=True)
            bad += 1
            continue
        if anchors_only:
            continue
        target = work / rel
        target.write_text(original.replace(find, rep), encoding="utf-8")
        try:
            r = subprocess.run(["node", "scripts/node-tests.mjs", suite, *filters], cwd=work, capture_output=True, text=True, timeout=900, env=env)
            out = r.stdout + r.stderr
            broken = re.search(r"(SyntaxError|ERR_MODULE_NOT_FOUND|Cannot find module|ReferenceError)[^\n]*", out)
            if broken:
                print(f"[skip] {name:{name_width}s} la variante ne se charge pas : {broken.group(0)[:100]}", flush=True)
                bad += 1
                continue
            failed = [re.sub(r"\s*\([\d.]+ms\)$", "", m) for m in re.findall(r"^\s*✖ (.+)$", out, re.M) if "failing tests" not in m]
            ok = r.returncode != 0 and bool(failed)
            shown = "; ".join(dict.fromkeys(f[:60] for f in failed))[:140] or "aucun test en échec"
            print(f"[{'tuée' if ok else 'SURVIVANTE'}] {name:{name_width}s} -> {shown}", flush=True)
            bad += not ok
        finally:
            target.write_text(original, encoding="utf-8")
    print("ancres périmées :" if anchors_only else "mutations non tuées :", bad)
    sys.exit(1 if bad else 0)
