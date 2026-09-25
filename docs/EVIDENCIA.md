# Evidencia y archivo sellado

*English below.*

## Qué hace Vigía

- **Archivo sellado.** Cada día UTC (de 00:00 a 24:00 UTC, es decir de 20:00 a 20:00 hora de Caracas), Vigía toma
  todas las observaciones que recibió ese día, calcula la huella SHA-256 de cada una y las reúne en un árbol de
  Merkle. La raíz del árbol, el número de filas y el resumen del día anterior forman el **resumen del día**. Cada
  día queda encadenado al anterior: cambiar, borrar o añadir una sola fila de un día sellado cambia su resumen y
  el de todos los días siguientes. El día se sella una hora después de terminar.
- **Guardar evidencia.** En cada incidente (y en el menú ⋯ de cada panel) el botón «Guardar evidencia» descarga un
  archivo JSON con: las observaciones que lo sostienen (enlace a la fuente original, hora en que la fuente dice que
  ocurrió y hora en que Vigía la recibió), lo que mostraba la pantalla, las reglas con que se decidió, la prueba de
  Merkle de cada observación y el resumen de su día. Nada más: ninguna clave, ningún dato personal.

## Cómo comprobarlo

```
vigia verify                         # ¿el archivo de este equipo sigue igual que cuando se selló?
vigia verify vigia-evidencia-….json  # ¿este archivo de evidencia es íntegro?
```

`vigia verify <archivo>` comprueba, sin conexión: la huella del archivo; que cada observación produce su huella
(todos sus campos: fuente, serie, horas, enlace, licencia, lugar, y el valor por su propia huella); que su prueba
llega al resumen sellado de su día; y, si este equipo tiene un archivo de Vigía, que ese día coincide con el suyo.
Nada de lo que el archivo dice sobre sí mismo cuenta: si este equipo selló un día, es su archivo el que decide si
una observación de ese día está o no está. Solo dice «íntegra» (código 0) cuando **todas** las observaciones quedan
comprobadas contra el archivo de este equipo; si alguna no se puede comprobar, sale con código 2 y dice cuántas; si
algo no cuadra, código 1. Los resúmenes están en `/api/archive/digests` (solo huellas, nunca datos).

## Lo que prueba y lo que no

- Prueba que el archivo no cambió **desde que se vio un resumen**. Si alguien reescribiera el archivo y todos sus
  resúmenes, solo lo delataría una copia anterior del resumen guardada en otro sitio. Por eso conviene copiar el
  resumen más reciente (la «cabeza de la cadena») fuera de este equipo, o publicarlo.
- Las observaciones de hoy aún no están selladas: el archivo las marca así. Guarde la evidencia de nuevo después de
  la 01:00 UTC del día siguiente para tener su prueba completa.
- No prueba que la fuente dijera la verdad: prueba qué publicó la fuente y cuándo lo recibió Vigía.
- Las fuentes cuyos términos prohíben redistribuir sus datos (RIPEstat) nunca entran en un archivo de evidencia. Las
  que solo permiten mostrar con atribución (IODA, los titulares de los medios) entran sin su valor («withheld»), pero
  con todos sus demás campos y la huella del valor, que la prueba cubre: cambiar su serie, su enlace o su estado la
  rompe. «withheld» solo vale para esas licencias. Los días sellados con el formato 1 (antes del 25 de septiembre de
  2026) no pueden probar una fila sin su valor: esas filas cuentan como «sin comprobar», nunca como probadas.
- Sin un archivo de Vigía con el que comparar, `vigia verify <archivo>` dice «coherente, pero NO comprobada» y sale
  con código 2: un archivo coherente se puede fabricar; solo la coincidencia con resúmenes publicados lo ancla.
- Vigía guarda las huellas de las filas de cada día sellado. Si se configura una retención, cada fila borrada de un
  día sellado deja su huella anotada como borrada por la retención: el día sigue coincidiendo (`vigia verify` dice
  cuántas se borraron) y las filas que quedan siguen teniendo su prueba. Una fila borrada por otra vía se detecta.

## Formato

- Fila (formato 2): SHA-256 del JSON canónico (claves ordenadas) de `{source, series, observedAt, fetchedAt,
  sourceUrl, licence, confidence, basis, valueHash, lat, lon, state, place}`, con `valueHash` = SHA-256 del JSON
  canónico del valor. (Formato 1, los primeros días sellados: el mismo objeto con `value` en lugar de `valueHash`.)
- Árbol: hojas = SHA-256(0x00 ‖ huella de fila) en orden de huella; nodo = SHA-256(0x01 ‖ izq ‖ der); un nodo sin
  pareja sube sin cambios.
- Resumen del día: SHA-256 de `{formato}\n{resumen anterior}\n{día}\n{filas}\n{raíz}`, con `{formato}` =
  `vigia-chain/2` (o `vigia-chain/1` para los días sellados antes); el primero parte de 64 ceros.
- Archivo de evidencia: formato `vigia-evidence/2` (se siguen comprobando los `vigia-evidence/1`); `sha256` es la
  huella del JSON canónico sin ese campo. Cada campo se valida al leerlo, y todo lo que `vigia verify` imprime pasa
  por el mismo limpiador que `/ahora.txt` (sin caracteres de control ni secuencias de escape).

---

## English

Each UTC day of received observations is sealed into a Merkle root chained to the previous day's digest (an hour
after the day ends). "Save evidence" on an incident or a panel downloads one JSON file with the observations
(source link, observed and received times), the on-screen snapshot, the rules, each observation's Merkle proof and
its day's digest. `vigia verify` re-checks this machine's archive; `vigia verify <file>` checks a bundle offline and
against the local archive when there is one: every row hash is recomputed from all its fields (the value by its own
hash, so rows withheld for their licence are still bound field by field), and whether a day is sealed is decided by
this machine's archive, never by the file. Exit 0 only when every observation is confirmed against this machine's
archive; 2 when some cannot be checked (with the count), including when there is no local archive to compare with
("coherente, pero NO comprobada": a consistent file can be fabricated; only a match with published digests anchors
it); 1 when anything fails. It proves the archive has not changed since a digest was seen; keep a copy of the chain
head elsewhere to make rewriting detectable. It proves what a source published and when Vigía received it, not that
the source was right. Today's rows are not sealed yet. Sources that forbid redistribution (RIPEstat) are never
included; sources that only allow display with attribution (IODA, outlets' headlines) are included with their value
withheld, keeping their hash, proof and link. Each sealed day's row hashes are kept, so a retention period records
what it deletes and the chain keeps verifying. The format is described in the Spanish section above ("Formato").
