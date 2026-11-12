# KAN-50 — Regulatory rules specification (octagons and minimum label fields)

Status: **draft v0.1 — pending competent review**

- Rule-set version: `kan50-rules-0.1-draft` (2026-11-02). No rule here is approved. Every rule
  becomes usable as an *approved* reference only after the sign-off at the end of this file.
- Consumers: KAN-36 (label text), KAN-37 (nutrient input and confirmation), KAN-38 (octagon
  engine), KAN-39 (front-label composer), KAN-40 (minimum-field checklist), KAN-59 (golden set).
  These tickets cite rule IDs from this file and do not re-interpret the sources.
- Gate policy: KAN-68 Option B (owner approval recorded 2026-11-02). Approved golden-set cases
  block on PR, nightly, and release. `CANDIDATE` cases run and are reported, but never block and
  never count toward the 100 % (P0436).
- Thesis anchors: P0305–P0313 (RF-03 referential text, «verificar con DIGESA»), P0321–P0327 (RF-04
  octagons, user confirmation of critical values), P0333–P0341 (RF-05 composition), P0576, P0663,
  P0688.
- Method: official sources only (El Peruano, gob.pe/MINSA, DIGESA, FAO). Spanish legal text is
  quoted verbatim. Some El Peruano text was taken from a two-column text layer. Rules that depend
  on reconstructed layout are flagged and listed under *Pending / ambiguous*. Retrieval date for
  all sources: 2026-11-02.

## 1. Sources

| ID | Norm / document | Publication (as stated by source) | Vigencia (as stated by source) | URL |
|---|---|---|---|---|
| S1 | **DS 017-2017-SA**, Reglamento de la Ley 30021 | El Peruano 17/06/2017 | "entra en vigencia a los seis (6) meses, contados a partir del día siguiente de su publicación" (DS, 1ª DCF). MINSA FAQ (S9, Q29) dates this to 18/12/2017. | https://busquedas.elperuano.pe/normaslegales/decreto-supremo-que-aprueba-el-reglamento-de-la-ley-n-30021-decreto-supremo-n-017-2017-sa-1534348-4/ · text: https://elperuano.pe/NormasElperuano/2017/06/17/1534348-4/1534348-4.htm |
| S2 | **DS 012-2018-SA**, Manual de Advertencias Publicitarias (MAP) | El Peruano 16/06/2018 | "entra en vigencia a los doce (12) meses, contados a partir del día siguiente de su publicación" (Única DCF). MINSA (S8) says octagons apply "Desde el 17 de junio de 2019". | https://busquedas.elperuano.pe/dispositivo/NL/1660606-1 · text: https://elperuano.pe/NormasElperuano/2018/06/16/1660606-1/1660606-1.htm |
| S3 | **DS 015-2019-SA**, modifies the Reglamento (1ª DCF exceptions) and MAP §8 | El Peruano 15/06/2019 | Not stated in the retrieved text | https://busquedas.elperuano.pe/normaslegales/decreto-supremo-que-modifica-el-reglamento-de-la-ley-no-3002-decreto-supremo-n-015-2019-sa-1779615-4/ · text: https://elperuano.pe/NormasElperuano/2019/06/15/1779615-4/1779615-4.htm |
| S4 | **DS 017-2023-SA**, modifies MAP §8.3 and §8.5 (adhesives) | El Peruano 30/06/2023 | Not stated in the retrieved text | https://busquedas.elperuano.pe/dispositivo/NL/2191835-1 |
| S5 | **Ley 31919**, modifies Ley 30021 art. 10 (adhesives for imports and MYPE) | El Peruano 08/11/2023 | 3ª DCF: providers adapt "en un plazo no mayor de ciento ochenta días calendario de la entrada en vigencia de la norma técnica peruana de adhesivos" (INACAL) | https://busquedas.elperuano.pe/dispositivo/NL/2232593-2 |
| S6 | **DS 033-2016-SA**, Reglamento for the gradual elimination of trans fats | El Peruano 27/07/2016 (pp. 595117–595119) | "entrará en vigencia a los ciento ochenta (180) días calendario contados a partir del día siguiente de su publicación" | FAO FAOLEX reproduction of the El Peruano pages: https://faolex.fao.org/docs/pdf/per160202.pdf |
| S7 | MINSA, *Comunicado de entrada en vigencia de la segunda fase de los parámetros técnicos* | gob.pe, 15/09/2021 | "a partir del 17 de setiembre de 2021 entran en vigencia los nuevos parámetros técnicos, correspondientes a la segunda fase" | https://www.gob.pe/institucion/minsa/informes-publicaciones/2156537-comunicado-de-entrada-en-vigencia-de-la-segunda-fase-de-los-parametros-tecnicos-en-el-marco-del-cumplimiento-del-reglamento-de-la-ley-n-30021-ley-de-promocion-de-la-alimentacion-saludable-para-ninas-ninos-y-adolescentes |
| S8 | MINSA, *Conoce las advertencias publicitarias (octógonos)* (orientation page, non-normative) | gob.pe, "Último cambio 14 enero 2024" | n/a | https://www.gob.pe/1066-ministerio-de-salud-conoce-las-advertencias-publicitarias-octogonos |
| S9 | MINSA, *Matriz de consultas recibidas al Manual de Advertencias Publicitarias* (FAQ, non-normative) | gob.pe PDF, file metadata 17/04/2019 | n/a | https://cdn.www.gob.pe/uploads/document/file/309096/Respuestas_del_Minsa_sobre_el_Manual_de_Advertencias_Publicitarias.pdf |
| S10 | **DS 007-98-SA**, Reglamento sobre Vigilancia y Control Sanitario de Alimentos y Bebidas, arts. 116–117 | "Publicado: 25 de setiembre de 1998" (DIGESA copy) | Not stated in the retrieved copy. Consolidation with later amendments not verified. | https://www.digesa.minsa.gob.pe/Codex/D.S.007_98_SA.pdf |
| S11 | **Codex CXS 1-1985**, General Standard for the Labelling of Pre-packaged Foods | "Adopted in 1985 … Revised in 2018"; 2024 revision (CAC47, December 2024) on allergen labelling; "redesigned and published in 2026" | International reference. It has no vigencia in Peru by itself (see PA-13). | https://openknowledge.fao.org/handle/20.500.14283/ce0073en |
| S12 | RM 526-2022/MINSA, which publishes a **draft** DS to update the art. 4 parameters | El Peruano 19/07/2022 | Draft only. Adoption not found (see PA-04). | https://busquedas.elperuano.pe/dispositivo/NL/2087682-1 |
| — | **NTP 209.038** (INACAL), *Alimentos envasados. Etiquetado* | **Not accessed.** Paid INACAL standard; edition and date unknown. | — | — |

Chain of MAP amendments named in the recitals of S12: DS 015-2019-SA, 021-2020-SA, 018-2021-SA,
and 005-2022-SA, followed by DS 017-2023-SA (S4). The 2020–2022 decrees extended the adhesive
deadlines in §8.3. S4 later rewrote §8.3 and §8.5. Those three decrees were not read
individually.

## 2. Scope and exceptions

| Rule | Statement | Source |
|---|---|---|
| R-SCOPE-01 | The art. 4 parameters and the warnings apply to *alimentos procesados*. Reglamento art. 15: "Las advertencias publicitarias serán aplicables a aquellos alimentos procesados cuyo contenido de sodio, azúcar, grasas saturadas, grasas-trans excedan los parámetros técnicos establecidos, conforme a lo señalado en el artículo 4". | S1 art. 15 |
| R-SCOPE-02 | Exceptions to art. 4 (1ª DCF as modified): "Las disposiciones establecidas en el artículo 4 no aplican a los alimentos y bebidas no alcohólicas en estado natural no sometidos a procesos de industrialización; los alimentos de procesamiento primario o mínimo; los alimentos de preparación culinaria y los alimentos de regímenes especiales sujetos al Codex Alimentarius." | S3 art. 1, modifying S1 1ª DCF |
| R-SCOPE-03 | Infant foods: "Con relación a los alimentos infantiles colados, picados y procesados a base de cereales para niños mayores de dos (2) años se exceptúan siempre y cuando no tengan adición de azúcares." Placement was read from a two-column layout (PA-09). | S3 |
| R-SCOPE-04 | Culinary ingredients are excluded: "En el caso de los ingredientes culinarios no resultan aplicables las disposiciones del presente Manual" (MAP §8.2). The definition (Reglamento art. 3.10, added by S2) is: "aceites vegetales, azucares, miel, sal, harinas". | S3 (MAP §8.2), S2 2ª DCM |
| R-SCOPE-05 | Definitions of *alimentos naturales / mínimamente procesados / procesamiento primario* (art. 3.2 as modified) and of *azúcares* ("también considerados azúcares libres o azúcares totales … más los azucares que están presentes naturalmente") (art. 3.4). The engine does not classify the product. The user declares the category and the engine applies these definitions. | S2 1ª DCM |

## 3. Inputs, units, bases, and critical values (KAN-37)

| Rule | Statement | Source |
|---|---|---|
| R-UNIT-01 | Bases: solids are per **100 g**; beverages are per **100 ml**. Units: sodium in **mg**; total sugar and saturated fat in **g** (art. 4 table: "mg /100g", "mg /100ml", "g /100g", "g /100ml"). | S1 art. 4 |
| R-UNIT-02 | Solid vs. liquid (MINSA guidance): "Un alimento es sólido o líquido según la unidad de medida utilizada en la declaración del contenido neto del alimento, es decir, será sólido si su contenido neto está expresado en gramos u otra medida equivalente, o líquido si su contenido neto está expresado en mililitros". Also: "entiéndase por bebidas a los líquidos". | S9 Q3–Q6, Q27 (non-normative) |
| R-UNIT-03 | Reconstituted products (MINSA guidance): "el cálculo de los parámetros se estimará, según como se declare el producto listo para su consumo, líquido o sólido, de acuerdo a las instrucciones declaradas por el fabricante." | S9 Q3, Q4, Q14 (non-normative) |
| R-UNIT-04 | Origin of values (MINSA guidance): "valores medios derivados de los resultados obtenidos de los análisis realizados en un laboratorio o de tablas de composición de alimentos debidamente reconocidas". | S9 Q7 (non-normative) |

**Critical values the user must confirm before determination** (P0327, P0576, KAN-37). Each one
is confirmed individually and stored with its value and this rule-set version. Editing a value
invalidates its confirmation.

| Field | Unit / domain | Rule |
|---|---|---|
| `physical_state` | `solid` (net content in g) or `liquid` (net content in ml) | R-UNIT-02 |
| `ready_to_consume_basis` | `as_sold` or `reconstituted` (values must then be for the ready-to-consume product) | R-UNIT-03 |
| `sodium` | mg per 100 g / 100 ml | R-UNIT-01 |
| `total_sugars` | g per 100 g / 100 ml | R-UNIT-01, R-SCOPE-05 |
| `saturated_fat` | g per 100 g / 100 ml | R-UNIT-01 |
| `trans_fat` | g per 100 g / 100 ml, plus origin (`added` / `natural_only` / `unknown`) | captured but **not** used for automatic determination (PA-02) |
| `exception_category` | none / natural-minimal-primary / culinary preparation / culinary ingredient / special-regime (Codex) / infant cereal without added sugar | R-SCOPE-02..04 |
| `front_panel_width_cm`, `front_panel_height_cm` → `front_panel_area_cm2` | cm, cm² (excluding seal areas, see R-SIZE-03) | R-SIZE-01..03 |

## 4. Octagon thresholds (KAN-38)

Reglamento art. 4 table, verbatim headers: "A los seis (6) meses de la aprobación del Manual de
Advertencias Publicitarias" (**phase 1**) and "A los treinta y nueve (39) meses de la aprobación
del Manual de Advertencias Publicitarias" (**phase 2**). The same table is reproduced in MAP
Cuadro 1.

| Rule | Nutrient · state | Phase 1 (historical) | **Phase 2 (applicable)** |
|---|---|---|---|
| R-THR-01 | Sodio · alimentos sólidos | "Mayor o igual a 800 mg /100g" | "**Mayor o igual a 400 mg /100g**" |
| R-THR-02 | Sodio · bebidas | "Mayor o igual a 100 mg /100ml" | "**Mayor o igual a 100 mg /100ml**" |
| R-THR-03 | Azúcar total · alimentos sólidos | "Mayor o igual a 22.5g /100g" | "**Mayor o igual a 10g /100g**" |
| R-THR-04 | Azúcar total · bebidas | "Mayor o igual a 6g /100ml" | "**Mayor o igual a 5g /100ml**" |
| R-THR-05 | Grasas saturadas · alimentos sólidos | "Mayor o igual a 6g /100g" | "**Mayor o igual a 4g /100g**" |
| R-THR-06 | Grasas saturadas · bebidas | "Mayor o igual a 3g /100ml" | "**Mayor o igual a 3g /100ml**" |
| R-THR-07 | Grasas trans | "Según la Normatividad Vigente" | "Según la Normatividad Vigente" → no numeric threshold; see PA-02 |

- **Applicable phase:** phase 2, in force "a partir del 17 de setiembre de 2021" (S7). Phase 1 is
  listed only so that tests can catch an engine that uses stale values (see PA-03).
- **Boundary semantics:** the table text is "Mayor o igual a" (≥). MINSA's FAQ agrees ("valor sea
  igual o mayor a lo indicado en el cuadro N°1", S9 Q30). Art. 15 and Ley 30021 art. 10 say
  "excedan" / "superen". The engine implements the table literal (≥). Boundary golden cases stay
  `CANDIDATE` until the reviewer resolves **PA-01**.
- **Comparison:** compare the confirmed decimal value as entered, with no rounding (PA-17).
- **Update clause:** art. 4 allows updates to phase-2 parameters "con una anticipación no menor a
  los doce (12) meses de su entrada en vigencia". A draft update exists (S12, PA-04).

## 5. Warning text and legends (KAN-38 output, KAN-39 composition)

| Rule | Statement | Source |
|---|---|---|
| R-TXT-01 | Inside the octagon: "ALTO EN", followed by "SODIO", "AZÚCAR", "GRASAS SATURADAS", "en uno o más símbolos independientes, según corresponda". | S2 MAP §3.2.1 |
| R-TXT-02 | Trans fats: "CONTIENE GRASAS TRANS". | S2 MAP §3.2.2 |
| R-TXT-03 | Below the octagon, "enmarcado con línea negra y fondo color blanco": "EVITAR SU CONSUMO EXCESIVO" (sodium/sugar/saturated fat). "EVITAR SU CONSUMO" (trans). | S2 MAP §3.3.1–3.3.2 |
| R-TXT-04 | With 2 or 3 "ALTO EN" warnings: "se considerará una sola leyenda «Evitar su consumo excesivo»", placed "al pie de los octógonos presentes". With all 4 warnings: two legends, one for the "ALTO EN" group and one for trans. | S2 MAP §3.3.3–3.3.5 |
| R-TXT-05 | Statutory phrases: "Alto en (sodio-azúcar-grasas saturadas): evitar su consumo excesivo" and "Contiene grasas trans: evitar su consumo". | S5 (Ley 30021 art. 10 as modified) |
| R-TXT-06 | MINSA guidance: other declarations such as "BAJO EN AZÚCAR" next to the parameters are incompatible ("Es incompatible el uso de declaraciones diferentes a las establecidas en el MAP"). KAN-36 must not generate them. | S9 Q30 (non-normative) |

## 6. Format, position, order, and size (KAN-38 geometry, KAN-39 composer)

| Rule | Statement | Source |
|---|---|---|
| R-FMT-01 | "Forma geométrica: Octógono. Color: negro y blanco. Tipografía: Helvética LT Std-Bold". The warnings must be shown "de manera clara, legible, destacada y comprensible en la cara frontal de la etiqueta". | S2 MAP §3, §3.1 |
| R-FMT-02 | Proportions follow MAP Anexo 1 ("Donde x es el tamaño de la línea negra externa del octógono"), including spacing (Anexo 1 E). Anexo 1 is graphic only; its transcription and the deterministic layout are in `octagon-geometry-spec.md` (PA-06). | S2 MAP Anexo 1 |
| R-FMT-03 | "Las advertencias publicitarias deben rotularse de forma indeleble en la etiqueta y no deben estar cubiertas de forma parcial o total por ningún otro elemento." | S3 (MAP §8.1); S5 |
| R-FMT-04 | MYPE: "Se permite a las micro y pequeñas empresas el uso de adhesivos o la impresión de forma indeleble en la cara frontal de la etiqueta". Adhesives must be "de naturaleza permanente, de difícil remoción, indelebles … no cubrir información al consumidor". Ley 31919 adds that adhesives must meet the "estándares de calidad que establece el Instituto Nacional de Calidad (Inacal)". | S4 (MAP §8.5); S5 |
| R-POS-01 | "Las advertencias publicitarias estarán ubicadas en la zona superior derecha de la cara frontal de la etiqueta. La ubicación … se mantendrá en todos los tamaños de las etiquetas." | S2 MAP §4.1 |
| R-POS-02 | Order "de derecha a izquierda": "ALTO EN SODIO. ALTO EN AZÚCAR. ALTO EN GRASAS SATURADAS." Trans: "se ubicará debajo de la primera línea al lado derecho". | S2 MAP §4.2 |
| R-POS-03 | Fallback: "En caso que el diseño de la etiqueta no permita seguir lo antes señalado el fabricante debe asegurar que la ubicación … permita que estas sean claramente visibles y legibles". Any engine output that uses this fallback is a manual-review case, not an automatic result. | S2 MAP §4.2 |
| R-SIZE-01 | Size depends on the area of "la cara frontal o cara principal de la etiqueta" (MAP Cuadro 2): **< 50 cm²** → "3,0 cm de ancho x 3.0 cm de alto (en la etiqueta del envase que contenga a los productos)"; **50 to < 100 cm²** → 2,0 × 2.0 cm; **100 to < 200 cm²** → 2,5 × 2.5 cm; **≥ 200 cm²** ("De 200 cm² a más") → 3,0 × 3.0 cm. Verified against the printed page (PA-08, resolved). The < 50 cm² row is corroborated by S9 Q31. | S2 MAP §5.1 Cuadro 2 |
| R-SIZE-02 | "En el caso de que la etiqueta tenga un área menor de 50 cm² se exceptuarán de rotular el o los símbolos con las advertencias «ALTO EN», en cuyo caso este o estos símbolos deberán rotularse en la etiqueta del envase mayor que los contenga." | S2 MAP §5.2 |
| R-SIZE-03 | Area computation (MINSA guidance): "multiplicar el alto por el ancho de la etiqueta"; other shapes use "fórmulas convencionales de superficie"; "no considerará el área de sellado de los empaques". The front face is "donde habitualmente se encuentra el nombre y la marca del producto". | S9 Q19 (non-normative) |

**Official graphic assets.** No official downloadable artwork (vector or raster) was found on
gob.pe, MINSA, or DIGESA. The only official geometry is MAP Anexo 1 in the El Peruano print
edition of 16/06/2018 (pp. 61–62). Composer assets (KAN-39) must not be redrawn from memory or
generated by a model; they are built from the Anexo 1 transcription in `octagon-geometry-spec.md` (PA-06).

## 7. Minimum label fields (KAN-36 text, KAN-40 checklist)

Peruvian minimum (S10, art. 117): "El contenido del rotulado debe ceñirse a las disposiciones
establecidas en la Norma Metrológica Peruana de Rotulado de Productos Envasados y contener la
siguiente información mínima:"

| Rule | Field (verbatim) | Codex counterpart (S11) | Notes |
|---|---|---|---|
| R-LBL-01 | "a) Nombre del producto." | 4.1 Name of the food ("shall indicate the true nature of the food") | Thesis: *denominación* (P0309) |
| R-LBL-02 | "b) Declaración de los ingredientes y aditivos empleados en la elaboración del producto." | 4.2.1 list of ingredients, "in descending order of ingoing weight (m/m)". 4.2.3.3 additives by functional class "together with the specific name or recognized numerical identification such as … (CXG 36-1989) as required by national legislation" | Thesis: generic name + INS/SIN code (P0309). Whether INS is mandatory in Peru: PA-13 |
| R-LBL-03 | — | 4.2.1.4 allergens "shall always be declared": cereals containing gluten (wheat, rye, barley), crustacea, egg, fish, peanut, milk, sesame, specific tree nuts (almond, cashew, hazelnut, pecan, pistachio, walnut). 4.2.1.7 sulphite ≥ 10 mg/kg | Codex 2024 list. Peruvian adoption: PA-13 |
| R-LBL-04 | "c) Nombre y dirección del fabricante." / "d) Nombre, razón social y dirección del importador, lo que podrá figurar en etiqueta adicional." | 4.4 Name and address | |
| R-LBL-05 | "e) Número de Registro Sanitario." | — | KAN-36 emits a **placeholder**, never a number (P0309) |
| R-LBL-06 | "f) Fecha de vencimiento, cuando el producto lo requiera con arreglo a lo que establece el Codex Alimentarius o la norma sanitaria peruana que le es aplicable." | 4.7.1 date marking | Conditional |
| R-LBL-07 | "g) Código o clave del lote." | 4.6 Lot identification | Placeholder |
| R-LBL-08 | "h) Condiciones especiales de conservación, cuando el producto lo requiera." | 4.7.2 storage instructions | Conditional |
| R-LBL-09 | — | 4.3 Net contents "in the metric system"; liquids by volume, solids by weight | Peruvian source is the Norma Metrológica (PA-11) |
| R-LBL-10 | — | 8.1.4 "The name and net contents of the food shall appear in a prominent position and in the same field of vision." 8.1.2 "clear, prominent, indelible and readily legible" | Composer layout check |
| R-LBL-11 | — | 4.5 country of origin "if its omission would mislead". 4.8 instructions for use "as necessary" | Conditional |
| R-LBL-12 | Octagons per §4–§6 when the engine determines them. MINSA guidance: octagons do not replace the nutrition table (S9 Q24) | — | KAN-40 identity check vs. KAN-38 |

Project policy (thesis requirements, not legal rules):

- **R-PRJ-01:** every label proposal contains, literally, «verificar con DIGESA» (P0311, KAN-36,
  KAN-40).
- **R-PRJ-02:** no output claims compliance certification ("nunca como certificación de
  cumplimiento", P0305). Each output records rule IDs and the rule-set version (P0313).

Proposed user-facing wording, for review under KAN-54: «Esta etiqueta es una propuesta
referencial y no certifica el cumplimiento de la normativa. Antes de imprimirla o venderla,
debes verificar con DIGESA.»

## 8. Pending / ambiguous — not rules

These items must not be implemented as approved rules until the reviewer resolves each one and
the resolution is recorded here.

| ID | Issue | Evidence | Effect until resolved |
|---|---|---|---|
| PA-01 | **Boundary semantics, ≥ vs. >.** The art. 4 table says "Mayor o igual a". Art. 15 and Ley art. 10 say "excedan" / "superen". | S1, S5, S9 Q30 | Engine uses ≥ per the table literal. Exact-boundary cases stay `CANDIDATE`. |
| PA-02 | **Trans-fat octagon trigger.** Art. 4: "Según la Normatividad Vigente". MAP §2 defers to DS 033-2016-SA, which sets *content limits* (2 g / 5 g trans per 100 g of fat, then elimination of partially hydrogenated sources at 54 months) and no labelling threshold. MINSA orientation page: "basta su sola presencia". MINSA FAQ Q10 exempts products with only naturally occurring trans fats. | S1, S2, S6, S8, S9 | No automatic «CONTIENE GRASAS TRANS». Any declared trans fat > 0 returns `needs_review`. |
| PA-03 | **Sources disagree on current values.** The MINSA orientation page (last changed 14/01/2024) still lists phase-1 values (22.5 g sugar, 800 mg sodium, 6 g saturated fat), while S1 and S7 put phase 2 in force since 17/09/2021. | S1, S7, S8 | Spec uses phase 2. The reviewer confirms. |
| PA-04 | **Draft parameter update.** RM 526-2022/MINSA published a draft DS to "actualiza[r] los parámetros técnicos". Its adoption was not found. Press reports of a per-100 kcal model are not official and were not used. | S12 | If adopted, every R-THR rule changes. |
| PA-05 | **No consolidated text checked.** SPIJ was not consulted. Changes after DS 017-2023-SA and Ley 31919 were not ruled out exhaustively. The MINSA adaptation of the MAP ordered by Ley 31919 (2ª DCF, 90 days) was not located. | S4, S5 | The reviewer confirms the current consolidated text. |
| PA-06 | **Anexo 1 proportions and official artwork.** These exist only as graphics in El Peruano 16/06/2018. No official downloadable files were found. Transcribed 2026-11-12 in `octagon-geometry-spec.md` (values marked A/D there), then checked against INACAL GP 110:2022 (read, non-binding; status G there), DS 015-2019-SA and DS 017-2023-SA. TBD-1 resolved by GP 110; TBD-2..5 decided by the owner 2026-11-12 and implemented in `src/labeling/octagon-geometry.ts` / `octagon-svg.ts`. | S2 | Geometry usable as `CANDIDATE`. |
| PA-07 | **What the Cuadro 2 size measures.** It is unclear whether "ancho x alto" covers the octagon only or also the legend box, and how size relates to "x". **Resolved 2026-11-12:** octagon only, x = S/30. INACAL GP 110:2022 §4.3: "Se considerará que octógonos son los que deberán cumplir con los tamaños de la ley" (x = 0,067 / 0,083 / 0,1 cm). See G-SIZE-01 in `octagon-geometry-spec.md`. | S2 + GP 110 | None. |
| PA-08 | **Cuadro 2 transcription** comes from a two-column text layer. **Resolved 2026-11-12:** checked against the printed page (p. 61); the row order < 50 → 3,0 · 50-<100 → 2,0 · 100-<200 → 2,5 · ≥ 200 → 3,0 is correct. | S2, S9 Q31 | None. |
| PA-09 | **1ª DCF infant-food sentence** (R-SCOPE-03): its placement was read from a two-column layout. | S3 | Exception flag requires review. |
| PA-10 | **NTP 209.038 not accessed** (paid INACAL). Edition, vigencia, and legal force are unknown. Its relation to DS 007-98-SA (which cites the Norma Metrológica, not NTP 209.038) is unclear. | — | Section 7 uses only DS 007-98-SA and Codex. |
| PA-11 | **Norma Metrológica Peruana (NMP 001)** not accessed. MINSA FAQ Q28 cites "NMP 001-2014" for the *cara de visualización principal*. | S9 | Net-content and front-face rules are partial. |
| PA-12 | **DS 007-98-SA** amendments: the DIGESA copy may be unconsolidated. | S10 | The reviewer confirms art. 117. |
| PA-13 | **Which Codex edition applies in Peru** and whether INS codes and the 2024 allergen list are mandatory. MINSA FAQ Q11: "Lo no establecido en el MAP se aplica la normativa del Codex Alimentarius" (no edition given). | S9, S11 | R-LBL-02/03 stay advisory. |
| PA-14 | **INACAL adhesive standard** under Ley 31919 (reported as NTP 202.900:2024) not verified. The vigencia of the MYPE adhesive allowance depends on it. | S5 | R-FMT-04 is informational. |
| PA-15 | **Advertising scope.** MAP §6.2.1: in print, street, and internet ads, warnings go "en un área que cubrirá hasta el 15% del tamaño del anuncio … ocuparan 3.75%". It is unclear whether CreaMype social-pack outputs are in scope. | S2 | Out of scope for this spec. |
| PA-16 | **Salt → sodium.** Art. 3.7 states "Un gramo de sal de mesa contiene 400mg de sodio". Using it to convert user input needs review. | S1 | KAN-37 asks for sodium in mg. No silent conversion. |
| PA-17 | **Precision and rounding.** There is no rule for decimal places. MINSA FAQ Q25 evaluates analytical deviation "de acuerdo a la incertidumbre que el laboratorio de ensayo declare". | S9 | Compare as entered and display the exact value compared. Any rounding rule needs one shared definition and a parity test. |
| PA-18 | **NTP 209.652:2025** (nutrition labelling, 4th ed., press-reported August 2026) not verified. | — | Affects the optional nutrition table (KAN-39). |

## 9. Candidate golden-set examples (all `CANDIDATE`)

Provenance format for KAN-59. Each case records: `id`, `status` (`CANDIDATE` | `APPROVED`),
`rules_version`, `rule_ids`, `inputs`, `expected`, `reviewer`, `review_date`. A case becomes
`APPROVED` only through the sign-off below (KAN-68). Rules version for all cases:
`kan50-rules-0.1-draft`. Nutrients are per 100 g (solid) or 100 ml (liquid). Sodium is in mg;
sugar and saturated fat are in g. Expected octagons are listed in MAP order, right to left
(R-POS-02).

| ID | Rules | State | Na | Sugar | Sat. fat | Other input | Expected | Note |
|---|---|---|---|---|---|---|---|---|
| G01 | THR-01/03/05 | solid | 399 | 9.9 | 3.9 | — | none | just below |
| G02 | THR-01/03/05, PA-01 | solid | 400 | 10 | 4 | — | SODIO, AZÚCAR, GRASAS SATURADAS; one legend | exact boundary |
| G03 | THR-01/03/05 | solid | 401 | 10.1 | 4.1 | — | SODIO, AZÚCAR, GRASAS SATURADAS | just above |
| G04 | THR-02/04/06 | liquid | 99 | 4.9 | 2.9 | — | none | just below |
| G05 | THR-02/04/06, PA-01 | liquid | 100 | 5 | 3 | — | SODIO, AZÚCAR, GRASAS SATURADAS | exact boundary |
| G06 | THR-02/04/06 | liquid | 101 | 5.1 | 3.1 | — | SODIO, AZÚCAR, GRASAS SATURADAS | just above |
| G07 | THR-03, TXT-01/03 | solid | 120 | 25 | 1 | — | AZÚCAR; legend «EVITAR SU CONSUMO EXCESIVO» | single warning |
| G08 | THR-01..06, UNIT-02 | solid | 150 | 7 | 3.5 | — | none | same numbers as G09 |
| G09 | THR-01..06, UNIT-02 | liquid | 150 | 7 | 3.5 | — | SODIO, AZÚCAR, GRASAS SATURADAS | state flips the result |
| G10 | THR-01 (phase 2), PA-03 | solid | 500 | 2 | 1 | — | SODIO | catches phase-1 threshold (800) |
| G11 | THR-03 (phase 2), PA-03 | solid | 50 | 22.4 | 0.5 | — | AZÚCAR | catches phase-1 threshold (22.5) |
| G12 | THR-05, PA-01 | solid | 380 | 9 | 4 | — | GRASAS SATURADAS | one exact boundary, two below |
| G13 | SCOPE-04 | solid | 0 | 99.8 | 0 | category = culinary ingredient (sugar) | none (exempt) | exception |
| G14 | THR-07, PA-02 | solid | 100 | 2 | 1 | trans_fat = 0.6, origin = added | `needs_review`; no automatic trans octagon | trans not automatic |
| G15 | UNIT-03, THR-04 | liquid (reconstituted) | 40 | 4.0 | 0.2 | as-sold powder has 40 g sugar / 100 g; ready-to-consume declared as liquid | none | uses reconstituted values |
| G16 | SIZE-01/02, PA-08 | solid | 450 | 1 | 1 | front area = 49.9 cm² | SODIO; not on this label; on containing package at 3,0 × 3,0 cm | below 50 cm² |
| G17 | SIZE-01, PA-08 | solid | 450 | 1 | 1 | front area = 50.0 cm² | SODIO, 2,0 × 2,0 cm | size boundary |
| G18 | SIZE-01, PA-08 | solid | 450 | 1 | 1 | front area = 99.9 / 100.0 cm² | 2,0 × 2,0 / 2,5 × 2,5 cm | size boundary pair |
| G19 | SIZE-01, PA-08 | solid | 450 | 1 | 1 | front area = 199.9 / 200.0 cm² | 2,5 × 2,5 / 3,0 × 3,0 cm | size boundary pair |
| G20 | POS-01/02, TXT-04 | liquid | 120 | 6 | 3.2 | — | upper-right zone; right to left: SODIO, AZÚCAR, GRASAS SATURADAS; one legend at the foot | order and legend |

## 10. Reviewer sign-off (competent review)

Fill in one block per review. A rule or case is approved only when it is listed under "Approved"
in a signed block. Pending items stay pending unless the block records their resolution.

```
Reviewer name:
Competence (e.g., food-regulatory specialist, DIGESA-experienced consultant; registration/colegiatura):
Organization:
Date of review:
Rule-set version reviewed:           kan50-rules-0.1-draft  (commit: ________)
Sources re-verified (S1–S12, consolidated text checked? Y/N):
Outcome:                             approved / approved with changes / rejected
Approved rule IDs:
Approved golden-set case IDs:
Pending items resolved (ID → decision):
Required changes:
Signature / evidence location:
```

Engineering review (separate from the competent review; does not approve rules):

```
Reviewer:            Date:            Commit:            Notes:
```
