---
name: arca-web-control
description: Operar de forma experimental y supervisada la web de ARCA en Windows mediante el CLI Playwright de este proyecto. Usar para login visible, aprendizaje local de operaciones nuevas y preparación hasta el resumen de una Factura C de Servicios de un ítem. La emisión permanece deshabilitada hasta revalidación visible. Tratar cualquier otra variante como aprendizaje visible, sin ejecutar acciones irreversibles.
---

# ARCA Web Control

## Preparación obligatoria

1. Leer `references/runtime.md`, `references/capabilities.md` y `references/commands.md`.
2. Leer `docs/estado-y-roadmap.md`, `docs/operacion-chrome.md`, `docs/protocolo-aprendizaje-operativo.md` y `docs/capacidades.md` antes de operar.
3. Para una factura, leer también `references/job-v2.md`.
4. Ejecutar únicamente desde la raíz del repositorio y usar comandos versionados.
5. Clasificar el pedido como conocido, variante, nuevo o irreversible.
6. No recibir claves fiscales, cookies, tokens, perfiles ni artefactos crudos por chat o argumentos.
7. Tratar el CUIT como identidad única del contribuyente. El nombre es una etiqueta no única; usarlo como selector solo si la resolución devuelve exactamente una coincidencia.

## Operación

- Para login conversacional visible, ejecutar `arca:session:start`, verificar `READY_STATE=portal` y retomar la misma sesión con `arca:session:cmd`.
- Navegar incrementalmente desde la pantalla actual. No reiniciar, volver al portal ni abrir una URL directa salvo pedido explícito.
- Para una capacidad nueva o variante, usar `arca:learn:start`; comenzar el registro después del login y detenerse antes de toda acción irreversible.
- Mantener eventos, notas, capturas y `candidate.json` exclusivamente en `%LOCALAPPDATA%\ManejoARCA\learning`. Nunca incorporarlos directamente a Git ni adjuntarlos a un issue o PR.
- En aprendizaje híbrido, ejecutar `inspect` antes de cada mutación y usar su `inspectionId` de un solo uso con `click-exact`, `select-exact`, `fill-input`, `check-exact` o `press`. Si hay varias pestañas ARCA, `inspect <índice-pestaña>` exige elegir una explícitamente y liga la inspección a esa página. Ignorar y no registrar pestañas de otros orígenes. Solo mutar pantallas ARCA conocidas previas al resumen. Las pantallas nuevas requieren interacción manual y los valores de `fill-input` llegan por stdin, nunca por argumentos.
- Si aparece captcha, selector ambiguo, control inesperado o pantalla no documentada, detenerse y pedir intervención humana.
- Ante `403 Forbidden` o `TU SESIÓN HA EXPIRADO`, no reenviar el formulario: finalizar el tramo, autenticar nuevamente y reconstruir el borrador.
- No improvisar selectores ni usar coincidencias parciales en producción.

## Facturas

1. Aceptar como única capacidad automatizada vigente `invoice-services-single-item`: Factura C, concepto Servicios, moneda local y un ítem, únicamente hasta el resumen. Cualquier otra variante debe pasar por aprendizaje visible.
2. Exigir un job `schemaVersion: 2` completo y validado.
3. Ejecutar `prepare-invoice <job>` y conservar el `preparedInvoiceId` devuelto.
4. Mostrar al usuario todo el resumen verificado, incluida la fecha de emisión, período y vencimiento.
5. No ejecutar `emit-prepared-invoice`: el manifiesto vigente mantiene la emisión de producción deshabilitada hasta una nueva validación visible y promoción humana.
6. Para revalidar la implementación irreversible pendiente, iniciar una sesión visible exclusiva con `--revalidate-irreversible invoice-services-single-item`. Después de mostrar el resumen, exigir un nuevo mensaje humano exactamente igual a `EMITIR` y ejecutar una sola vez `revalidate-prepared-invoice <preparedInvoiceId> EMITIR`. No releer ni sustituir el job y bloquear reintentos ante estado `unknown`.
7. La revalidación futura debe comprobar que, después de `Comprobante Generado`, se capture la descarga directa iniciada por `Imprimir...`, se valide el PDF y se extraigan número/CAE antes de marcar `emitted`.
8. Para Servicios, calcular el vencimiento cinco días corridos después de la emisión si el usuario no indica otro; dejar actividad, referencia comercial y unidad de medida sin selección por defecto. Si ARCA normaliza la unidad a `unidades` en el resumen, verificarla como salida del portal.
9. Leer `docs/regimenes-especificos.md` antes de informar una actividad asociada. Si el job declara un régimen específico, exigir que régimen y actividad coincidan con el perfil privado del CUIT emisor; los jobs v2 históricos con `activity` explícita siguen siendo compatibles.

## Aprendizaje durable

No considerar aprendido un flujo hasta incorporar código Playwright, pruebas, manifiesto, recuperación, registro técnico sanitizado sin artefactos crudos, roadmap y referencias sincronizadas. Leer `docs/protocolo-aprendizaje-operativo.md` al desarrollar una capacidad. Ejecutar `arca:capability:sync` y `arca:capability:check`; actualizar este archivo solo si cambian reglas o secuencias operativas generales.

No habilitar `production-hidden` salvo que el manifiesto declare simultáneamente `maturity: fast_path` y `hiddenAllowed: true` después de validación humana real.
