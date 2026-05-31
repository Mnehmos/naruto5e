#!/usr/bin/env python3
"""
Render the running Iwao / Dust Release campaign manuscript to a single PDF.

Design: each in-story WEEK is one Markdown-ish chapter file in chapters/ named
weekNN.md. This script globs them in order and rebuilds the whole PDF — the
visible "append a chapter to the running PDF" result, done robustly (no fragile
binary PDF concatenation).

Chapter file format (UTF-8):
    TITLE: Chapter 1 — The Weight of Stone
    DATES: Academy, Spring — Days 1-7
    ---
    <prose...>
    blank-line-separated paragraphs.
    ## A Section Header
    more prose. Inline **bold** and __underline__ are honored (fpdf2 markdown).
    ---LOG---
    <mission-log lines, rendered verbatim in a monospaced box>

Run:  python render_pdf.py
"""
import glob
import os
import sys
from fpdf import FPDF

HERE = os.path.dirname(os.path.abspath(__file__))
CH_DIR = os.path.join(HERE, "chapters")
OUT = os.path.join(HERE, "Iwao_DustRelease_Campaign.pdf")

# --- fonts: prefer a real unicode TTF so macrons (Ōnoki, Chūnin) render -------
WIN_FONTS = r"C:\Windows\Fonts"
FONT_SET = {
    "": os.path.join(WIN_FONTS, "arial.ttf"),
    "B": os.path.join(WIN_FONTS, "arialbd.ttf"),
    "I": os.path.join(WIN_FONTS, "ariali.ttf"),
    "BI": os.path.join(WIN_FONTS, "arialbi.ttf"),
}
MONO = os.path.join(WIN_FONTS, "consola.ttf")
MONO_B = os.path.join(WIN_FONTS, "consolab.ttf")
HAVE_UNICODE = all(os.path.exists(p) for p in FONT_SET.values())

INK = (28, 26, 24)
STONE = (122, 110, 98)
EMBER = (150, 60, 24)          # dust-release ember accent
LOGBG = (242, 238, 230)
LOGBORDER = (170, 150, 120)
RULE = (200, 188, 170)


def sanitize(s: str) -> str:
    """If no unicode font, fold the few non-latin1 glyphs we use."""
    if HAVE_UNICODE:
        return s
    table = {
        "Ō": "O", "ō": "o",  # Ō ō
        "Ū": "U", "ū": "u",  # Ū ū
        "—": "-", "–": "-", "’": "'", "‘": "'",
        "“": '"', "”": '"', "…": "...", "•": "*",
    }
    for k, v in table.items():
        s = s.replace(k, v)
    return s.encode("latin-1", "replace").decode("latin-1")


class Manga(FPDF):
    def __init__(self):
        super().__init__(format="A4")
        self.set_auto_page_break(True, margin=20)
        self.set_margins(20, 18, 20)
        if HAVE_UNICODE:
            for style, path in FONT_SET.items():
                self.add_font("Body", style, path)
            self.body = "Body"
            if os.path.exists(MONO):
                self.add_font("Mono", "", MONO)
                if os.path.exists(MONO_B):
                    self.add_font("Mono", "B", MONO_B)
                self.mono = "Mono"
            else:
                self.mono = "Courier"
        else:
            self.body = "Helvetica"
            self.mono = "Courier"

    def footer(self):
        if self.page_no() == 1:
            return
        self.set_y(-15)
        self.set_font(self.body, "I", 8)
        self.set_text_color(*STONE)
        self.cell(0, 10, sanitize(f"Iwao — The Particle Heir   ·   {self.page_no()}"),
                  align="C")

    def t(self, s):
        return sanitize(s)

    def mc(self, h, txt, **kw):
        """Width-explicit multi_cell: always span the full text column from the
        left margin, immune to cursor-X drift (fpdf2 w=0 can raise on bad X)."""
        self.set_x(self.l_margin)
        self.multi_cell(self.epw, h, txt, new_x="LMARGIN", new_y="NEXT", **kw)


def cover(pdf: Manga):
    pdf.add_page()
    pdf.ln(40)
    pdf.set_text_color(*EMBER)
    pdf.set_font(pdf.body, "B", 13)
    pdf.cell(0, 8, pdf.t("A NARUTO 5e ENGINE PLAYTEST · AUTONOMOUS RUN"), align="C")
    pdf.ln(22)
    pdf.set_text_color(*INK)
    pdf.set_font(pdf.body, "B", 40)
    pdf.cell(0, 18, pdf.t("IWAO"), align="C")
    pdf.ln(20)
    pdf.set_font(pdf.body, "B", 22)
    pdf.cell(0, 12, pdf.t("The Particle Heir"), align="C")
    pdf.ln(16)
    pdf.set_font(pdf.body, "I", 14)
    pdf.set_text_color(*STONE)
    pdf.cell(0, 8, pdf.t("A Dust Release Saga of the Hidden Stone"), align="C")
    pdf.ln(28)
    pdf.set_draw_color(*RULE)
    pdf.set_line_width(0.4)
    x = pdf.get_x()
    pdf.line(60, pdf.get_y(), 150, pdf.get_y())
    pdf.ln(10)
    pdf.set_font(pdf.body, "", 11)
    pdf.set_text_color(*INK)
    blurb = ("Born in Iwagakure with Dust Release — Jinton, the particle bloodline of the "
             "Third Tsuchikage himself — a boy named Iwao must prove he is worthy of a power "
             "the whole village remembers. Every die in these pages was rolled by the engine.")
    pdf.set_x(35)
    pdf.multi_cell(140, 6.5, pdf.t(blurb), align="C")


def parse_chapter(path):
    raw = open(path, encoding="utf-8").read().replace("\r\n", "\n")
    title, dates = "", ""
    lines = raw.split("\n")
    i = 0
    while i < len(lines) and lines[i].strip() != "---":
        ln = lines[i]
        if ln.startswith("TITLE:"):
            title = ln[6:].strip()
        elif ln.startswith("DATES:"):
            dates = ln[6:].strip()
        i += 1
    i += 1  # skip '---'
    body, log = [], []
    in_log = False
    while i < len(lines):
        ln = lines[i]
        if ln.strip() == "---LOG---":
            in_log = True
        elif in_log:
            log.append(ln)
        else:
            body.append(ln)
        i += 1
    return title, dates, "\n".join(body).strip("\n"), "\n".join(log).strip("\n")


def render_chapter(pdf: Manga, title, dates, body, log):
    pdf.add_page()
    pdf.set_text_color(*EMBER)
    pdf.set_font(pdf.body, "B", 19)
    pdf.mc(9, pdf.t(title))
    if dates:
        pdf.set_font(pdf.body, "I", 10.5)
        pdf.set_text_color(*STONE)
        pdf.mc(6, pdf.t(dates))
    pdf.set_draw_color(*RULE)
    pdf.set_line_width(0.3)
    pdf.ln(2)
    pdf.line(pdf.l_margin, pdf.get_y(), pdf.w - pdf.r_margin, pdf.get_y())
    pdf.ln(4)

    pdf.set_text_color(*INK)
    for para in body.split("\n\n"):
        para = para.strip()
        if not para:
            continue
        if para.startswith("## "):
            pdf.ln(2)
            pdf.set_font(pdf.body, "B", 13)
            pdf.set_text_color(*EMBER)
            pdf.mc(7, pdf.t(para[3:].strip()))
            pdf.set_text_color(*INK)
            pdf.ln(1)
            continue
        if para.startswith("> "):
            pdf.set_font(pdf.body, "I", 11)
            pdf.set_text_color(*STONE)
            pdf.mc(6.4, pdf.t(para[2:].strip()))
            pdf.set_text_color(*INK)
            pdf.ln(1)
            continue
        pdf.set_font(pdf.body, "", 11)
        pdf.mc(6.4, pdf.t(para.replace("\n", " ")), markdown=True)
        pdf.ln(1.5)

    if log:
        pdf.ln(3)
        if pdf.get_y() > pdf.h - 70:
            pdf.add_page()
        pdf.set_fill_color(*LOGBG)
        pdf.set_draw_color(*LOGBORDER)
        pdf.set_line_width(0.4)
        pdf.set_font(pdf.mono, "B", 9)
        pdf.set_text_color(*EMBER)
        pdf.mc(6, pdf.t("  MISSION LOG  —  engine-validated state"), border="LTR", fill=True)
        pdf.set_font(pdf.mono, "", 8.6)
        pdf.set_text_color(*INK)
        pdf.mc(4.9, pdf.t(log), border="LBR", fill=True)


def main():
    pdf = Manga()
    cover(pdf)
    files = sorted(glob.glob(os.path.join(CH_DIR, "week*.md")))
    if not files:
        print("no chapters yet", file=sys.stderr)
    for f in files:
        title, dates, body, log = parse_chapter(f)
        render_chapter(pdf, title, dates, body, log)
    pdf.output(OUT)
    print(f"OK rendered {len(files)} chapter(s) -> {OUT}")


if __name__ == "__main__":
    main()
