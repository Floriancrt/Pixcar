#!/usr/bin/env python3
"""Mutations sur la fenêtre « Confidentialité et mentions légales » (tests/legal.js) : voir lib.py. La suite construit sa propre page
à partir des sources modifiées (variable PIXCAR_SRC que lib.py renseigne)."""
import pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from lib import run

M = [
 # name, find, replace, sections, must-fail check prefix
 ("a click on the backdrop no longer closes it", 'if (e.target === dlg && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) close();', 'if (false) close();', "", "L11"),
 ("the window does not lock scrolling when it opens", '    root.classList.add("dlg-open");\n    "function" == typeof dlg.showModal', '    "function" == typeof dlg.showModal', "", "L3"),
 ("closing the window unlocks scrolling under the form that is still open", 'if (!doc.querySelector("dialog[open]")) root.classList.remove("dlg-open");', 'root.classList.remove("dlg-open");', "", "M7"),
 ("the window is not modal (no focus move, no backdrop)", '"function" == typeof dlg.showModal ? dlg.showModal() : dlg.setAttribute("open", "");', 'dlg.setAttribute("open", "");', "", "L3"),
 ("without showModal() the window cannot open", 'dlg.showModal() : dlg.setAttribute("open", "");', 'dlg.showModal() : void 0;', "", "F1"),
 ("without close() the scroll lock is never released", 'else (dlg.removeAttribute("open"), shut());', 'else dlg.removeAttribute("open");', "", "F2"),
 ("a browser without method=dialog reloads the page when the form is sent", '(e.preventDefault(), close())', 'close()', "", "F2"),
 ("the form link triggers nothing (no data-open-legal on the dialog's link)", '"[data-open-legal]"', '"[data-open-legal-x]"', "", "legal"),
 ("the window stays 24 px short of the edges on a phone", '@media (min-width: 600px) {\n  .dlg.legal {', '@media (min-width: 0px) {\n  .dlg.legal {', "", "T1"),
 ("the close button has no accessible name", '<button type="submit" class="dlg-close" aria-label="Fermer">', '<button type="submit" class="dlg-close">', "", "L7b"),
 ("the window has no accessible name", 'class="dlg legal" aria-labelledby="legalTitle"', 'class="dlg legal"', "", "L7b"),
 ("the declaration sections show in local mode", '<section aria-labelledby="lg-data" data-store-only="remote">', '<section aria-labelledby="lg-data">', "", "L5"),
 ("the local-storage sentence shows in API mode", '<span data-store-only="local">Elles restent dans ce navigateur', '<span>Elles restent dans ce navigateur', "", "M3"),
 ("the rights section does not give the contact", '<a href="mailto:{{legal.contact}}">{{legal.contact}}</a>. Pour retrouver', '{{legal.contact}}. Pour retrouver', "", "M3"),
]

if __name__ == "__main__":
    run(M, "legal.js", max(len(m[0]) for m in M))
