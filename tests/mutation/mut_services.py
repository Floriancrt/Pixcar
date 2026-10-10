#!/usr/bin/env python3
"""Mutations sur « plusieurs prestations » (fenêtre de choix et totaux, tests/services.js) : voir lib.py."""
import pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from lib import run

M = [
 # name, find, replace, sections, must-fail check prefix
 # ---- les totaux (modules/svc-combo.js)
 ("the total keeps only the first service's price", "const amount = Math.round(known.reduce((s, p) => s + p.price.amount, 0) * 100) / 100;", "const amount = known[0].price.amount;", "", "R1"),
 ("a missing price still gives a complete total", "partial: missing > 0 || known.some((p) => p.price.partial),", "partial: known.some((p) => p.price.partial),", "", "R9"),
 ("a garage that does none of them stays in the list", 'if (!done.length) return { lvl: "no" };', 'if (!done.length) return { lvl: "check", why: "?" };', "", "R5"),
 ("partial coverage is shown as available", 'return { lvl: "part", why: `${done.length} prestation', 'return { lvl: "yes", why: `${done.length} prestation', "", "R4"),
 # ---- la fenêtre (modules/service-picker.js)
 ("the contrôle technique mixes with other services", 'if (svc.kind === "ct" || max === 1) return [id];', "if (max === 1) return [id];", "", "P5a"),
 ("no cap on the number of services", "export const SVC_MAX = 5;", "export const SVC_MAX = 50;", "", "P6"),
 ("closing the window (Escape) applies the ticks", '  dlg.addEventListener("close", shut);\n  return { open, close', '  dlg.addEventListener("close", () => (shut(), apply(sel.slice())));\n  return { open, close', "", "P7"),
 ("the sheet's list does not give way on a small phone", ".svc-dlg form {\n  flex: 1 1 auto;\n  min-height: 0;\n}", ".svc-dlg form {\n  flex: 1 1 auto;\n}", "", "M1"),
 # ---- la page (app.js)
 ("only one service can be picked", "apply: svcApply });", "apply: svcApply, max: 1 });", "", "P1"),  # une seule prestation : la zone des pastilles disparaît (P1)
 ("browsing the price page drops the selection", "if (me.svcs.length > 1 && me.svcs.includes(pe.refService.value)) return void refShow(", "if (!1) return void refShow(", "", "R1"),
 ("the landmarks ignore the other services", "if (ss.length > 1) {\n      // plusieurs prestations : fourchette", "if (!1) {\n      // plusieurs prestations : fourchette", "", "P11"),
]

if __name__ == "__main__":
    run(M, "services.js", max(len(m[0]) for m in M))
