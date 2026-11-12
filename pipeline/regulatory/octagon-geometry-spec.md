# Octagon geometry and size: deterministic specification

Status: **v0.3, implemented 2026-11-12, not reviewed by a competent person.** TBD-2..5 decided by the owner on 2026-11-12. Complements
`KAN-50-regulatory-rules-spec.md` (source ids S1-S12, rule ids R-*, and PA-xx refer to that file)
and transcribes what KAN-50 left as PA-06: the MAP Anexo 1 proportions. Consumer: the octagon
renderer (`src/labeling/octagon-svg.ts`) and any future label composer (KAN-39).

Goal: given (a) the set of required warnings and (b) the front face of the label, the engine
produces **one exact geometry**, with no free parameter left to the implementer. Every value below
carries a status:

| Status | Meaning | Can we change it? |
|---|---|---|
| **N** | Normative text (Ley, Reglamento, MAP), quoted verbatim | No |
| **A** | Dimension printed in MAP Anexo 1 or Gráfico 1 | No |
| **G** | INACAL GP 110:2022 guidance (non-binding). Used only where N/A are silent or ambiguous, never against them | Only if MINSA/DIGESA says otherwise |
| **D** | Derived: computed from **A** values or measured on the official figure, with the evidence stated | Only if a better copy of the figure contradicts it |
| **I** | Implementation choice; the sources are silent | Yes, without legal impact |
| **TBD** | Open decision for the owner or the legal review (KAN-54). The recommended option is what the engine implements until the decision is recorded | Owner decides |

## 0. Sources read for this file (accessed 2026-11-12)

| Source | What it gives | Binding |
|---|---|---|
| MAP, DS 012-2018-SA (S2), El Peruano 16/06/2018, pp. 60-63. Copies: https://static.legis.pe/wp-content/uploads/2018/06/Legis.pe-Decreto-supremo-salud-octogono-2.pdf, https://faolex.fao.org/docs/pdf/per188361.pdf | §3 format, §4 position and order, §5 sizes (Cuadro 2), Anexo 1 proportions, Gráfico 1 | Yes |
| DS 015-2019-SA | Rewrites MAP numeral 8 (8.1-8.7): adhesives, permanence, returnable containers (8.7) | Yes |
| DS 017-2023-SA | Modifies MAP 8.3/8.5: adhesives must follow the MAP (same artwork and sizes) | Yes |
| Ley 31919 | Amends Ley 30021 art. 10 on adhesives; no geometry change | Yes |
| MINSA FAQ (S9) | Q17-Q20, Q22, Q28, Q31: area, front face, small packages, outer containers | Official guidance |
| INACAL GP 110:2022, Guía Peruana for implementing the warnings (copy: https://alertas-v3.directoriolegislativo.org/wp-content/uploads/2022/12/Gu%C3%ADa-peruana-110.pdf), pp. 13-19 | §4.3 sizes and x, legend alignment; §4.4 dark packaging; §4.5.1 area formulas (from NMP 001); §4.5.2 containers | No (**G**) |
| NTP 202.900:2024 | Adhesive material quality only; no geometry | Voluntary |

The Anexo figures are low-resolution rasters in every copy found. Labels printed on them are
legible; the smallest tick labels ("x/2") are not (see G-LEG-02). No official downloadable artwork
exists (gob.pe, MINSA, DIGESA, S9 checked), so this geometry **is** the official artwork.
No MAP modification after DS 017-2023-SA was found (gob.pe search, 2026-11-12).

**Watch list (not law on 2026-11-12):** PL 6461 would remove the < 50 cm² exemption (G-SIZE-02).
If it is enacted, `SMALL` stops meaning "on the container" and Cuadro 2 will need a new row.

## 1. Inputs and outputs

```
input  : warnings  ⊆ { alto_en_sodio, alto_en_azucar, alto_en_grasas_saturadas, contiene_grasas_trans }, non-empty
         frontFace : { shape: 'RECT', widthMm, heightMm }
                   | { shape: 'CYLINDER', heightMm, circumferenceMm }
                   | undefined                              // cara de visualización principal
         whiteBase : boolean                                // G-OCT-08; composer sets it
output : sizeClass, placement, unit x (mm), the set geometry (section 4), bounding box (mm),
         the area that was compared, and status: OK | MANUAL_REVIEW (with reason) | SIZE_UNKNOWN
         | INVALID_INPUT (G-AREA-05 rejection, with a message)
```

The renderer works in **units of x** (section 3) and turns them into millimetres only at the end:
the SVG `viewBox` is in x units and its `width`/`height` attributes are in `mm`. The geometry is
therefore identical for every size; only the scale changes (**I**).

## 2. Size from the front-face area

### 2.1 Area (rules G-AREA-*)

| Id | Rule | Status | Source |
|---|---|---|---|
| G-AREA-01 | Size depends on "rangos del área total de la cara frontal o cara principal de la etiqueta". | N | MAP §5.1 |
| G-AREA-02 | Area = "multiplicar el alto por el ancho de la etiqueta". The sealing area of the package is excluded ("no considerará el área de sellado de los empaques"). | N (MINSA guidance) | S9 Q19 |
| G-AREA-03 | The front face is the *cara de visualización principal* of NMP 001-2014: "donde habitualmente se encuentra el nombre y la marca del producto". NMP 001 Anexo B excludes "la parte superior, la parte inferior, los rebordes de la parte superior e inferior de las latas, y los resaltes y cuellos de las botellas y frascos", and GP 110 extends that criterion to every package shape. The UI tells the user to measure **without** these parts and without the sealing area. | N (S9) + G (exclusions, GP §4.5.1) | S9 Q19, Q28; GP 110 §4.5.1 |
| G-AREA-04 | Shape formulas (GP 110 §4.5.1, from NMP 001): rectangle `A (Ancho) × B (Alto)`; cylinder `40 % [B (Alto) × C (Circunferencia)]`; triangle `A (Base) × B (Altura) / 2`; trapezoid `B (Alto) × [A (Base menor) + C (Base mayor)] / 2`; composite `A1 + A2` (rhombus `C × D / 2`, ellipse `A × B × π`). **v1 implements `RECT` and `CYLINDER` only** (boxes, bags, jars, bottles). Any other shape → `MANUAL_REVIEW`, and the message quotes the GP formula for that shape. | G (formulas) + I (v1 subset) | GP 110 §4.5.1 |
| G-AREA-05 | Inputs are positive decimals in mm with **at most one decimal place**. More decimals → rejected with a message, never rounded. The engine stores them as integer tenths of a millimetre and computes the area as an **integer in units of 0.001 mm²** (`A3`): `RECT`: `A3 = 10 × w10 × h10`; `CYLINDER`: `A3 = 4 × h10 × c10` (the 40 % stays exact). All comparisons use this integer. The circumference is measured, not derived from a diameter, so π never enters a comparison. | I | user rule: no rounding before a regulatory comparison |
| G-AREA-06 | The UI shows the **exact** area that was compared (`A3 / 100 000` cm², five decimals, e.g. `49,95000 cm²`) and the resulting class. Never a rounded area next to a class it does not match. | I | — |
| G-AREA-07 | `frontFace` missing → status `SIZE_UNKNOWN`: the engine still renders the set (vector, scalable), and the UI says the print size depends on the front-face area. | I | — |
| G-AREA-08 | Width and height used by the fit check (G-POS-03): `RECT`: `widthMm × heightMm`; `CYLINDER`: `0.4 × circumferenceMm` wide × `heightMm` tall (the face the formula counts). | D (from G-AREA-04) | — |

### 2.2 Size classes (MAP Cuadro 2, read on the printed page; this resolves PA-08)

Half-open intervals, exactly as worded ("Menor a", "De … a menor …", "De … a más"):

| Class | Front-face area | In 0.001 mm² units (`A3`) | Size **S** | Placement | Status |
|---|---|---|---|---|---|
| `SMALL` | "Menor a 50 cm²" | `A3 < 5 000 000` | 30 mm | Not on this label (G-SIZE-02) | N |
| `S20` | "De 50 a menor 100 cm²" | `5 000 000 ≤ A3 < 10 000 000` | 20 mm | This label | N |
| `S25` | "De 100 a menor 200 cm²" | `10 000 000 ≤ A3 < 20 000 000` | 25 mm | This label | N |
| `S30` | "De 200 cm² a más" | `A3 ≥ 20 000 000` | 30 mm | This label | N |

| Id | Rule | Status |
|---|---|---|
| G-SIZE-01 | **S is the width (= height) of one octagon**, i.e. 30x. So `x = S / 30`: 0.6667 mm (S20), 0.8333 mm (S25), 1.0000 mm (S30, SMALL). The legend box is added below and is not part of S. GP 110 §4.3 states it directly: "Se considerará que octógonos son los que deberán cumplir con los tamaños de la ley", with x = 0,067 / 0,083 / 0,1 cm for 2 / 2,5 / 3 cm. Also consistent with Cuadro 2 "ancho x alto" being square, which only holds for the octagon alone. **Resolves TBD-1 and PA-07.** | D + G (GP §4.3) |
| G-SIZE-02 | `SMALL`: "se exceptuarán de rotular el o los símbolos con las advertencias «ALTO EN» … deberán rotularse en la etiqueta del envase mayor que los contenga". The engine outputs `placement = CONTAINER`, S = 30 mm, and tells the user the octagons go on the outer package, not on this label. | N (MAP §5.2; S9 Q17, Q31) |
| G-SIZE-03 | Which outer package: "Si los productos son contenidos en un envase mayor (A), este último deberá llevar la advertencia". A further package (B) used "únicamente para transporte" does not carry them, "pero si este envase para transporte (B) es utilizado también para exhibición en venta si corresponde". The `CONTAINER` message says this in plain words. | G (GP §4.5.2) + N (S9 Q20) |
| G-SIZE-04 | `SMALL` with `contiene_grasas_trans`: §5.2 exempts only the "ALTO EN" symbols, and Cuadro 2 gives no size for a trans symbol on a label smaller than 50 cm². GP 110 §4.5.2 repeats the MAP text and adds nothing. The engine returns `MANUAL_REVIEW` (reason: "advertencia de grasas trans en etiqueta menor a 50 cm²"). | I (TBD-3 decided 2026-11-12) |
| G-SIZE-05 | One size class per label. All symbols in the set use the same x. | D (Cuadro 2 gives one size per label) |

## 3. The unit x and the single symbol

"Donde **x** es el tamaño de la línea negra externa del octógono" (**A**, Anexo 1 A-D).
Coordinates below: origin at the top-left corner of the symbol's bounding box, y pointing down,
units of x.

### 3.1 Octagon (rules G-OCT-*)

| Id | Rule | Status | Evidence |
|---|---|---|---|
| G-OCT-01 | Regular octagon, flat top and bottom, outer width **30x** = outer height. | A (30x) + D (regular) | Measured top edge ≈ 12.6x; regular octagon edge = 30/(1+√2) = 12.43x |
| G-OCT-02 | Three concentric regular octagons: **black, width 30** (outer line) · **white, width 28** (ring) · **black, width 26** (field). So the outer black line is x thick and the white ring is x thick, measured perpendicular to each edge. | D | Anexo A/B: 2 + 4 + 18 + 4 + 2 = 30 across, 2 + 9 + 3 + 2 + 3 + 9 + 2 = 30 down. The double tick at the top right of each figure marks x (black) + x (white). GP 110 p. 15 draws the same three rings |
| G-OCT-03 | Vertices of a regular octagon of width `w` centred at (15, 15), with `h = w/2` and corner cut `c = w / (2 + √2)`: (15−h+c, 15−h), (15+h−c, 15−h), (15+h, 15−h+c), (15+h, 15+h−c), (15+h−c, 15+h), (15−h+c, 15+h), (15−h, 15+h−c), (15−h, 15−h+c). For w = 30, 28, 26: c = 8.7868, 8.2010, 7.6152. | D | Geometry |
| G-OCT-04 | Colours: black `#000000`, white `#FFFFFF`, both opaque. For print: black = 100 % K. No other colour, gradient, transparency, shadow or outline. | N ("Color: negro y blanco") + I (hex values, 100 % K) | MAP §3.1 |
| G-OCT-05 | Nothing else inside or on the symbol. In particular **no "MINSA" text** and no logo: neither Gráfico 1, Anexo 1 nor GP 110 shows one. | A | Gráfico 1, Anexo 1 |
| G-OCT-06 | The warnings "no podrán estar cubiertas de forma parcial o total por ningún otro elemento" and must be "indeleble". | N | MAP §8 / R-FMT-03 |
| G-OCT-07 | The set is never rotated, mirrored, skewed, recoloured or **inverted** (white on black → black on white), and never scaled non-uniformly. The only scale is the uniform `S/30` of section 1 plus the glyph scale of G-TXT-04. | D (fixed proportions and colours of §3.1 and Anexo 1) |
| G-OCT-08 | **Dark packaging:** "si el envase del producto es predominantemente oscuro o negro, se recomienda colocar una base de color blanco para que se cumpla con la condición de destaque del octógono". S9 Q18 says the label must be adapted so the warning stands out. When `whiteBase` is true, the renderer adds one white `#FFFFFF` rectangle behind the set: the set bounding box grown by **x on every side**. The bounding boxes in §4.2 and the fit check (G-POS-03) then add 2x to W and H. Inverting colours is never the fix (G-OCT-07). Deciding *when* the background is dark belongs to the composer (KAN-39); until it exists, the UI asks the user. | G (GP §4.4) + N (S9 Q18) + I (margin x) |

### 3.2 Text inside the octagon (rules G-TXT-*)

| Id | Rule | Status |
|---|---|---|
| G-TXT-01 | Exact lines, uppercase, with the accent on Ú. **No other line breaks.** | A (Gráfico 1, Anexo 1) |

| Warning | Line 1 | Line 2 | Line 3 | Cap height | Gap between lines | Width of the widest line (**target**) |
|---|---|---|---|---|---|---|
| `alto_en_sodio` | ALTO EN | SODIO | — | 3x | 2x | 18x ("ALTO EN") |
| `alto_en_azucar` | ALTO EN | AZÚCAR | — | 3x | 2x | 18x ("ALTO EN") |
| `alto_en_grasas_saturadas` | ALTO EN | GRASAS | SATURADAS | 3x | x | 25x ("SATURADAS") |
| `contiene_grasas_trans` | CONTIENE | GRASAS | TRANS | 3x | x | 21x ("CONTIENE") |

All of these values are **A**. Sources: Anexo A, B (3x / 2x / 3x, 4x | 18x | 4x), C (3x / x / 3x / x / 3x, x/2 | 25x | x/2), D (3x / x / 3x / x / 3x, 2.5x | 21x | 2.5x). The trans text is **three** lines (Anexo D, GP 110 p. 15), not two.

| Id | Rule | Status |
|---|---|---|
| G-TXT-02 | **Vertical position:** the text block (the cap heights plus the gaps) is centred vertically on the symbol centre y = 15. Baselines: 2-line symbols at **y = 14 and 19**. 3-line symbols at **y = 12.5, 16.5, 20.5**. Check: 2-line top margin = 11 − 2 = 9x, which matches the 9x in Anexo A/B. 3-line margins = 7.5x; the Anexo labels them "7x", but 7 + 11 + 7 = 25 ≠ 26 (inner field), so the figure is internally off by 1x and centring resolves it. | D |
| G-TXT-03 | **Horizontal position:** every line is centred on x = 15. | D (all figures) |
| G-TXT-04 | **Width:** compute `k = target / naturalWidth(widestLine)` with the font of G-FONT-01 at the cap height of G-TXT-01, using advance widths only (no kerning). Apply `k` as a horizontal scale to **all lines of that symbol**. For Helvetica Bold metrics, k ≈ 0.981 (sodio, azúcar), 0.953 (grasas saturadas), 0.972 (trans). | A (targets) + I (the uniform scale method, no kerning) |
| G-TXT-05 | Guard: if any `k` falls outside **[0.90, 1.10]**, the font is wrong. The renderer throws an error; it never draws a stretched glyph. | I |
| G-TXT-06 | Accents (Ú) rise above the cap height and do not count toward it. | D (typographic convention; Gráfico 1 shows AZÚCAR at the same cap height as ALTO EN) |

### 3.3 Font (rules G-FONT-*)

| Id | Rule | Status |
|---|---|---|
| G-FONT-01 | "Tipografía: Helvética LT Std-Bold". GP 110 §4.4 repeats it. | N (MAP §3.1) |
| G-FONT-02 | Font size from cap height: `fontSize = capHeight / (capHeightUnits / unitsPerEm)`, read from the font file. For Helvetica Bold (cap height 718/1000): octagon text = 3x / 0.718 = **4.178x**, legend text = 1.9x / 0.718 = **2.646x**. | D |
| G-FONT-03 | The output must **not depend on fonts installed on the viewer's machine**: text is emitted as glyph outlines (SVG paths) taken from one fixed font file, with its advance widths. Today the code uses a system-font stack, so the result varies by device. | I (needed for the geometry above to be exact) |
| G-FONT-04 | Which font file: (a) a licensed Helvetica LT Std Bold (literal compliance; commercial license), or (b) **TeX Gyre Heros Bold** (free Helvetica clone, GUST Font License) for the pilot, flagged in the KAN-54 legal review. **Decided 2026-11-12: (b).** Outlines are pre-generated by `scripts/gen-octagon-glyphs.py` into `src/labeling/octagon-glyphs.ts`; Heros cap height is 729/1000, so the font sizes of G-FONT-02 become 4.115x and 2.606x. | I (TBD-4 decided) |

### 3.4 Legend box (rules G-LEG-*)

| Id | Rule | Status | Evidence |
|---|---|---|---|
| G-LEG-01 | Below the octagon, "enmarcado con línea negra y fondo color blanco". | N | MAP §3.3 |
| G-LEG-02 | Box: **30x wide × 6.6x tall** (outer edges). Black border **x/2** thick, drawn inside those edges. White fill. | A (30x, 6.6x) + D (border) | Anexo B labels the two text slots 2.8x + 2.8x = 5.6x, so 6.6 − 5.6 = 1x = two borders of x/2. Matches the "x/2" ticks at the top and bottom of the box, which are illegible at the source resolution |
| G-LEG-03 | Gap between the octagon and its box: **x**. | A | Anexo E (right figure: x above the box, x below it) |
| G-LEG-04 | **Single "ALTO EN" symbol:** two lines, "EVITAR SU CONSUMO" / "EXCESIVO". Each line sits in a 2.8x slot with a **cap height of 1.9x**, centred in the slot. Baselines at box top **+ 2.85x** and **+ 5.65x**. | A (two lines, 1.9x, 2.8x slots) + D (baselines) | Anexo A/C label 1.9x per line; Anexo B labels the 2.8x slots |
| G-LEG-05 | **Trans symbol:** one line, "EVITAR SU CONSUMO", **cap height 1.9x**, centred vertically. Baseline at box top **+ 4.25x**. The Anexo D label "2.8x" is read as the slot, as in Anexo B: the measured cap on the figure is 1.9-2.1x, and the line is as wide as the same line in A-C (≈ 27x), so the font size is the same. | A (one line) + D (1.9x) | Anexo D, measured |
| G-LEG-06 | Legend width: natural width at 1.9x cap height, centred on the box. If the widest line is wider than the box minus **3x** (27x for a 30x box, 61x for the shared 64x box), it is scaled horizontally to that width (G-TXT-04 method, same guard). 27x is measured on the figures, not dimensioned. Helvetica Bold gives 28.67x for "EVITAR SU CONSUMO" → k = 0.942; the shared line "EVITAR SU CONSUMO EXCESIVO" (≈ 42.9x) needs no scale. | D (measured) + I |
| G-LEG-07 | Text colour black, uppercase as drawn in Gráfico 1 and Anexo 1. The Ley and the Reglamento write the phrase in sentence case ("Evitar su consumo excesivo", R-TXT-05); the MAP is what fixes how it is drawn, so the symbol always carries the uppercase form. Same statutory wording, two typographic renderings. | N (wording, R-TXT-05) + A (uppercase) |
| G-LEG-08 | GP 110 §4.3 adds: "Para la advertencia de sodio en el recuadro inferior, se recomienda usar 2x para que la frase entre en el rectángulo." This confirms that the Anexo "2.8x" is not the text height (the phrase would not fit). The engine keeps the Anexo A/C value, **1.9x**, for every legend, and the width guard of G-LEG-06 handles the fit. | A over G |

**Single symbol bounding box:** 30x × 37.6x (octagon 30 + gap 1 + box 6.6). (**D**)

## 4. Composition of several warnings (rules G-SET-*)

| Id | Rule | Status | Source |
|---|---|---|---|
| G-SET-01 | Order "de derecha a izquierda": **SODIO** (rightmost), **AZÚCAR**, **GRASAS SATURADAS** (leftmost). Only the warnings present are drawn; the others are skipped without leaving a gap. GP 110 §4.2 tables give the same order for every combination. | N | MAP §4.2 |
| G-SET-02 | "ALTO EN" octagons sit in one row, top-aligned, **2x apart** (outer edge to outer edge). | A | Anexo E (left figure) |
| G-SET-03 | 2 or 3 "ALTO EN" warnings: **one** legend, "una sola leyenda «Evitar su consumo excesivo»", "al pie de los octógonos presentes", on **one line**: "EVITAR SU CONSUMO EXCESIVO". Box 6.6x tall, border x/2, gap x below the row, cap height 1.9x, baseline at box top + 4.25x, text centred. | N (MAP §3.3.3) + A (one line, Gráfico 1) + D (same box metrics as G-LEG) |
| G-SET-04 | Width of that shared box: **64x, centred under the row.** GP 110 §4.3: the box "se alineará con la mitad de los extremos del octógono respetando el tamaño de la fuente y el alto del rectángulo, centrando el texto". For **3** octagons that runs from the centre of the leftmost (x = 15) to the centre of the rightmost (x = 79): 64x, which also matches the undimensioned Gráfico 1. For **2** octagons the literal rule gives 32x (15 → 47), too narrow for the text at the fixed font size (≈ 42.9x), so it cannot be followed "respetando el tamaño de la fuente"; the GP figure (p. 15) draws the same ≈ 64x box centred under the 62x row, overhanging x on each side. | G (N = 3) · I for N = 2 (TBD-2 decided 2026-11-12: the GP figure, 64x) |
| G-SET-05 | Trans: "se ubicará debajo de la primera línea al lado derecho". Its octagon is **right-aligned with the rightmost "ALTO EN" octagon**, **x below** the "ALTO EN" legend box, and carries **its own** legend, "EVITAR SU CONSUMO" (G-LEG-05), x below it. With all four warnings there are two legends. GP 110 p. 15 draws a trans octagon **centred** below its 2-octagon example; read as one composition that contradicts MAP §4.2 and Gráfico 1, which prevail. GP §4.2 itself says "Grasas Trans (debajo)" without contradicting "al lado derecho". | N (MAP §4.2, §3.3.4-3.3.5) + A (Gráfico 1; Anexo E gives the x gaps) |
| G-SET-06 | A single "ALTO EN" warning plus trans: one column, right-aligned, no row. ALTO EN octagon, its two-line legend (G-LEG-04), then the trans octagon x below, then its legend. | N + D |
| G-SET-07 | Each warning's octagon appears **once**. Never one image per octagon each carrying its own "EXCESIVO" legend when there are 2-3 "ALTO EN" warnings, because that breaks "una sola leyenda". The deliverable is **one image of the whole set**. | N (MAP §3.3.3); TBD-5 decided 2026-11-12, F20 updated (decision D33) |

### 4.1 Layout algorithm (x units, origin at the top-left corner of the set)

```
A     = present ALTO EN warnings in LEFT-TO-RIGHT order, filtered from [grasas_saturadas, azucar, sodio]
N     = |A|;  T = contiene_grasas_trans present
rowW  = N ≥ 1 ? 32·N − 2 : 30                           // octagons + 2x gaps
boxW  = N ≥ 2 ? 64 : 30                                  // G-SET-04 / G-LEG-02
W     = max(rowW, boxW)                                  // set width: 30, 64, 94
rowL  = (W − rowW) / 2                                   // 0, except 1 when N == 2
boxL  = (W − boxW) / 2                                   // 0 (N ≤ 2), 15 (N == 3)
for i in 0..N−1: octagon A[i] at (rowL + 32·i, 0)
if N == 1: legend box (0, 31, 30, 6.6), two lines              // G-LEG-04
if N ≥ 2: legend box (boxL, 31, 64, 6.6), one line             // G-SET-03/04
yT    = N ≥ 1 ? 38.6 : 0
xT    = N ≥ 1 ? rowL + rowW − 30 : 0                     // right edge of the rightmost octagon
if T: trans octagon at (xT, yT); legend box (xT, yT + 31, 30, 6.6), one line   // G-LEG-05
H     = (N ≥ 1 and T) ? 76.2 : 37.6                      // set height
```

Box rectangles are given as (left, top, width, height). The border stroke is x/2, centred on the
rectangle inset by x/4, so the outer edge of the stroke lies on the given rectangle. With
`whiteBase` (G-OCT-08) everything shifts by (1, 1) and the white plate is (0, 0, W + 2, H + 2).

### 4.2 Bounding boxes (W × H, without white base)

| Set | x units | S20 (mm) | S25 (mm) | S30 / SMALL (mm) |
|---|---|---|---|---|
| 1 warning (any) | 30 × 37.6 | 20.00 × 25.07 | 25.00 × 31.33 | 30.00 × 37.60 |
| 2 ALTO EN | 64 × 37.6 | 42.67 × 25.07 | 53.33 × 31.33 | 64.00 × 37.60 |
| 3 ALTO EN | 94 × 37.6 | 62.67 × 25.07 | 78.33 × 31.33 | 94.00 × 37.60 |
| 1 ALTO EN + trans | 30 × 76.2 | 20.00 × 50.80 | 25.00 × 63.50 | 30.00 × 76.20 |
| 2 ALTO EN + trans | 64 × 76.2 | 42.67 × 50.80 | 53.33 × 63.50 | 64.00 × 76.20 |
| 3 ALTO EN + trans | 94 × 76.2 | 62.67 × 50.80 | 78.33 × 63.50 | 94.00 × 76.20 |

The octagon text cap height is 2.00 / 2.50 / 3.00 mm and the legend cap height is
1.27 / 1.58 / 1.90 mm for S20 / S25 / S30.

## 5. Position on the label (rules G-POS-*)

| Id | Rule | Status |
|---|---|---|
| G-POS-01 | "zona superior derecha de la cara frontal de la etiqueta", the same in every label size. The set's top-right corner goes at the top-right of the front face. | N (MAP §4.1; GP §4.4 repeats it) |
| G-POS-02 | The MAP sets no margin from the label edge. The composer (KAN-39, deferred) chooses it. | I |
| G-POS-03 | Fit check: when `frontFace` is known and the set's bounding box (mm, including the white base if any) is wider or taller than the face of G-AREA-08, the result is `MANUAL_REVIEW` (R-POS-03 fallback, also GP §4.4: "el fabricante debe asegurar que la ubicación de las advertencias permita que estas sean claramente visibles y legibles"). The engine never shrinks the set below S. | N (fallback text) + I (the check) |

## 6. Out of scope (the engine says so instead of guessing)

- **Returnable containers** (MAP 8.7 as rewritten by DS 015-2019-SA): allows the warnings on the
  cap/crown (tapa/chapa) or on adhesives/bands for returnable containers already in circulation.
  v1 does not model it; the UI does not claim compliance for that case.
- **Adhesives** (MAP 8.3/8.5 as modified by DS 017-2023-SA; Ley 31919): the same artwork, sizes
  and position apply, so this geometry is reused unchanged. Material quality (NTP 202.900:2024) is
  not geometry.
- **Which products need warnings at all** (exceptions in GP §4.6 / Reglamento) and the nutrient
  thresholds: KAN-50, not this file.
- Advertising in print, outdoor and internet media (MAP §6.2, "hasta el 15% … 3.75%"; INDECOPI
  declared it an illegal barrier), radio/TV (§6.3), and online catalogues (S9 Q22). This file
  covers labels only.

## 7. Open decisions

| Id | Question | Recommended (implemented until decided) | Alternative |
|---|---|---|---|
| ~~TBD-1~~ | Does Cuadro 2 measure the octagon only? | **Resolved 2026-11-12** by GP 110 §4.3: octagon only, x = S/30 (G-SIZE-01) | — |
| ~~TBD-2~~ | Shared legend width for **2** ALTO EN | **Decided 2026-11-12 (owner):** 64x centred, as the GP figure draws it | — |
| ~~TBD-3~~ | Trans warning on a label smaller than 50 cm² | **Decided 2026-11-12 (owner):** `MANUAL_REVIEW` | — |
| ~~TBD-4~~ | Font file | **Decided 2026-11-12 (owner):** TeX Gyre Heros Bold, flagged in KAN-54 | — |
| ~~TBD-5~~ | Deliverable granularity | **Decided 2026-11-12 (owner):** one image per set; F20 updated (D33) | — |

## 8. Golden cases (all `CANDIDATE` until the KAN-54 review; tested in `src/labeling/__tests__/octagon-geometry.test.ts` and `octagon-svg.test.ts`)

| # | Warnings | Front face (mm) | Area compared | Expected |
|---|---|---|---|---|
| G1 | sodio | RECT 120.0 × 100.0 | 120,00000 cm² | S25, x = 0.8333 mm, set 25.00 × 31.33 mm, two-line legend |
| G2 | grasas saturadas, azúcar, sodio | RECT 250.0 × 100.0 | 250,00000 cm² | S30, left→right GS · AZÚCAR · SODIO at x = 0, 32, 64; one-line legend box (15, 31, 64, 6.6); set 94 × 37.6 mm |
| G3 | sodio, grasas saturadas | RECT 150.0 × 100.0 | 150,00000 cm² | S25, left→right GS · SODIO at x = 1, 33 (no gap where AZÚCAR would go); legend box (0, 31, 64, 6.6); set 53.33 × 31.33 mm |
| G4 | azúcar, trans | RECT 100.0 × 60.0 | 60,00000 cm² | S20, one column: AZÚCAR + two-line legend, trans at y = 38.6x + its legend, set 20.00 × 50.80 mm |
| G5 | all four | RECT 300.0 × 100.0 | 300,00000 cm² | S30, row of 3 + legend box (15, 31, 64, 6.6), trans right-aligned at (64, 38.6), two legends, set 94 × 76.2 mm |
| G6 | sodio | RECT 100.0 × 50.0 | 50,00000 cm² (boundary) | S20 |
| G7 | sodio | RECT 99.9 × 50.0 | 49,95000 cm² | SMALL → placement CONTAINER, 30 mm, container message (G-SIZE-03) |
| G8 | sodio | RECT 100.0 × 100.0 | 100,00000 cm² (boundary) | S25 |
| G9 | sodio | RECT 200.0 × 100.0 | 200,00000 cm² (boundary) | S30 |
| G10 | trans | RECT 60.0 × 60.0 | 36,00000 cm² | MANUAL_REVIEW (TBD-3) |
| G11 | all four | RECT 120.0 × 45.0 | 54,00000 cm² | S20, set 62.67 × 50.80 mm is taller than 45.0 → MANUAL_REVIEW (G-POS-03) |
| G12 | sodio | RECT 100.05 × 50.0 | — | `INVALID_INPUT`: more than one decimal place (G-AREA-05) |
| G13 | sodio | (none) | — | SIZE_UNKNOWN, vector set rendered, notice shown |
| G14 | any | any | — | SVG contains no "MINSA", only `#000000`/`#FFFFFF`, no `<text>` element (outlined glyphs), 3 concentric octagons per symbol of widths 30/28/26, no transform other than uniform scale and the glyph scale |
| G15 | grasas saturadas, sodio, trans | RECT 250.0 × 100.0 | 250,00000 cm² | S30, octagons at x = 1, 33; legend box (0, 31, 64, 6.6); trans at (33, 38.6) under SODIO; set 64 × 76.2 mm |
| G16 | sodio | CYLINDER alto 80.0, circunferencia 200.0 | 64,00000 cm² (`A3 = 4 × 800 × 2000`) | S20; fit face 80.0 × 80.0 mm; set 20.00 × 25.07 mm fits → OK |
| G17 | sodio | CYLINDER alto 50.0, circunferencia 250.0 | 50,00000 cm² (boundary) | S20 |
| G18 | sodio | triangle | — | MANUAL_REVIEW, message quotes "A (Base) x B (Altura)/2" (G-AREA-04) |
| G19 | sodio, `whiteBase` | RECT 120.0 × 100.0 | 120,00000 cm² | S25, white plate 32x × 39.6x = 26.67 × 33.00 mm, octagon at (1, 1) |

## 9. Implementation (2026-11-12)

- `src/labeling/octagon-geometry.ts`: `layoutOctagonSet` (section 4.1) and `octagonSizing` (sections 2 and
  G-POS-03). Pure; regulatory comparisons use integers only.
- `src/labeling/octagon-svg.ts`: `octagonSetSvg` (one SVG per set, x units, `width`/`height` in mm when
  `xMm` is given) and `octagonSetLabel` (accessible text). Throws if a text scale leaves [0.90, 1.10].
- `src/labeling/octagon-glyphs.ts`: generated outlines (G-FONT-03/04).

Not implemented yet: the UI does not collect the front face or the dark-packaging flag, so
`LabelResultView` always shows `SIZE_UNKNOWN` (G-AREA-07) and no white base. Container placement and
the fit check exist in `octagonSizing` but are not reachable from the UI until those inputs exist.
