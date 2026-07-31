---
name: arca-web-control
description: Controlar de forma conversacional, rápida y supervisada la web de ARCA en Windows mediante el motor Playwright de este proyecto. Usar para recibir datos por chat, iniciar o reutilizar Chrome visible, preparar hasta el resumen una Factura C de Servicios de un ítem y aprender variantes nuevas. Mantener toda acción irreversible separada y sujeta a confirmación humana exacta.
---

# ARCA Web Control

## Preparación

1. Para una operación conocida, leer `references/runtime.md`, `references/credentials.md`, `references/capabilities.md` y `references/job-v2.md`. Consultar `references/commands.md` solo si hace falta una primitiva de diagnóstico.
2. Leer la documentación de desarrollo completa únicamente al cambiar código, aprender una variante o promover una capacidad; no ejecutar validaciones de repositorio antes de cada factura rutinaria.
3. Ejecutar desde la raíz del repositorio y clasificar el pedido como conocido, variante, nuevo o irreversible.
4. Tratar el CUIT como identidad única. Un nombre puede usarse si el proveedor devuelve exactamente un contribuyente; ante ambigüedad, pedir CUIT. En el selector de representado, priorizar un control que contenga el CUIT exacto y luego el nombre completo sin importar el orden. Solo si ninguno aparece, admitir que el nombre guardado y el nombre canónico asociado por ARCA al CUIT exacto difieran en un único segundo nombre o apellido completo; el control accionable debe coincidir exactamente con ese nombre canónico y ser único. No usar distancia de edición, coincidencias parciales ni esta tolerancia sin el CUIT visible.
5. Respetar el proveedor elegido por el usuario. No exigir el Administrador de credenciales de Windows, no repetir una clave en la respuesta y no trasladarla a argumentos, logs, Git o artefactos fiscales.

## Operación

- Para una factura cuyos datos llegan por chat, generar un UUID privado `intentId` para esa solicitud y usar una sola invocación a `arca:invoice:prepare-chat` con JSON por `stdin`. Reutilizar ese UUID únicamente al reconstruir o reintentar la misma intención; una factura nueva, aunque tenga datos idénticos, recibe otro. Esta ruta valida y normaliza datos, resuelve el emisor una vez, crea o reutiliza el mismo job idempotente, inicia o reutiliza Chrome visible y devuelve el resumen; no copiar handles ni `intentId` internos en la conversación.
- Usar `arca:session:start`, `arca:job:create` y `arca:session:cmd` como primitivas de diagnóstico o recuperación, no como preámbulo obligatorio del flujo conversacional normal.
- Navegar incrementalmente desde la pantalla actual. No reiniciar, volver al portal ni abrir una URL directa salvo pedido explícito.
- Para una capacidad nueva o variante, usar `arca:learn:start`; comenzar el registro después del login y detenerse antes de toda acción irreversible.
- Mantener eventos, notas, capturas y `candidate.json` exclusivamente en `%LOCALAPPDATA%\ManejoARCA\learning`. Nunca incorporarlos directamente a Git ni adjuntarlos a un issue o PR.
- En aprendizaje híbrido, ejecutar `inspect` antes de cada mutación y usar su `inspectionId` de un solo uso con `click-exact`, `select-exact`, `fill-input`, `check-exact` o `press`. Si hay varias pestañas ARCA, `inspect <índice-pestaña>` exige elegir una explícitamente y liga la inspección a esa página. Ignorar y no registrar pestañas de otros orígenes. Solo mutar pantallas ARCA conocidas previas al resumen. Las pantallas nuevas requieren interacción manual y los valores de `fill-input` llegan por stdin, nunca por argumentos.
- Si aparece captcha, selector ambiguo, control inesperado o pantalla no documentada, detenerse y pedir intervención humana.
- Si una sesión visible queda pausada por captcha, no reenviar el login en el mismo aviso. Después de que el usuario confirme que intervino, ejecutar explícitamente `arca:session:cmd -- resume-authentication` en una sesión operativa o `arca:learn:cmd -- resume-authentication` en un aprendizaje, siempre sobre el mismo Chrome. Si el captcha continúa o la pantalla no es el login oficial esperado, volver a detenerse. Una credencial rechazada clausura toda reanudación posterior y detiene ese worker sin un segundo intento.
- Ante `ARCA_INVALID_CREDENTIALS`, informar y detenerse sin un segundo intento.
- Ante `403 Forbidden` o `TU SESIÓN HA EXPIRADO` antes del primer clic irreversible, no reenviar el formulario: finalizar el tramo, autenticar nuevamente y reconstruir el borrador con el mismo `intentId`. Si ocurre después del clic, prevalece `unknown`: no reconstruir ni reemitir y reconciliar primero.
- No improvisar selectores ni usar coincidencias parciales en producción.

## Facturas

1. Aceptar como única capacidad automatizada vigente `invoice-services-single-item`: Factura C, concepto Servicios, moneda local y un ítem, únicamente hasta el resumen. Cualquier otra variante debe pasar por aprendizaje visible.
2. Exigir datos completos. La entrada conversacional acepta fechas `DD/MM/AAAA` o ISO, importe argentino o decimal canónico y vencimiento `Default`; el motor los normaliza antes de abrir Chrome.
3. Ejecutar `arca:invoice:prepare-chat`, conservar el `preparedInvoiceId` devuelto y mantener la misma sesión visible.
4. Mostrar emisor, CUIT del emisor, punto de venta, tipo, concepto, moneda, fecha, período, vencimiento, receptor con su CUIT, condición frente al IVA, domicilio, condición de venta, descripción, cantidad, precio unitario, subtotal y total. No inferirlos: deben provenir del resumen estructurado verificado.
5. Si el usuario no indicó domicilio, aceptar automáticamente solo cuando ARCA devuelva exactamente uno. Ante dos o más, no elegir el primero ni el predeterminado: mostrar las opciones y detenerse hasta recibir una selección explícita. Después de recibirla, conservar `intentId`, incrementar `intentRevision` y reconstruir el borrador; esta revisión solo se admite antes del primer clic irreversible y sobre un ledger `failed_before_emit` o una preparación huérfana.
6. No ejecutar `emit-prepared-invoice`: el manifiesto vigente mantiene la emisión de producción deshabilitada hasta una nueva validación visible y promoción humana.
7. Para revalidar la implementación irreversible pendiente, iniciar una sesión visible exclusiva con `--revalidate-irreversible invoice-services-single-item`. Después de mostrar el resumen, exigir un nuevo mensaje humano exactamente igual a `EMITIR` y ejecutar una sola vez `revalidate-prepared-invoice <preparedInvoiceId> EMITIR`. No releer ni sustituir el job. Antes del primer clic se reservan el ledger y una atestación ligada a la versión de la capacidad. Si una falla comprobada ocurre antes de intentar ese clic, se libera la atestación, el ledger vuelve a `failed_before_emit` y la sesión consumida debe cerrarse antes de reconstruir. Desde el primer intento de clic, cualquier timeout, desconexión, caída o resultado incierto queda —o se recupera como— `unknown` y nunca habilita un reintento automático.
8. La revalidación futura debe comprobar que, después de `Comprobante Generado`, exista exactamente un `Imprimir...`, que el listener se instale antes de su único clic, que se capture y valide la descarga directa y que se extraigan número/CAE antes de marcar `emitted`. Ante ausencia, ambigüedad o falla, no abrir una URL alternativa ni repetir el clic.
9. Publicar el PDF y su JSON de metadatos únicamente después de validarlos, bajo `downloads\Emisores\<CUIT formateado - nombre>\Comprobantes Emitidos\<AAAA>\<MM>`. Usar el CUIT como identidad, reutilizar una única carpeta existente y bloquear duplicados o colisiones; nunca sobrescribir.
10. Para Servicios, calcular el vencimiento cinco días corridos desde el campo `date` del comprobante si el usuario no indica otro; dejar actividad, referencia comercial y unidad de medida sin selección por defecto. Si ARCA normaliza la unidad a `unidades` en el resumen, verificarla como salida del portal.
11. Leer `docs/regimenes-especificos.md` antes de informar una actividad asociada. Si el job declara un régimen específico, exigir que régimen y actividad coincidan con el perfil privado del CUIT emisor; los jobs v2 históricos con `activity` explícita siguen siendo compatibles.

## Rendimiento y mantenimiento

- No ejecutar reparaciones recursivas, `takeown`, UAC, `npm audit`, tests, sincronización de capacidades ni `autoreview` durante una factura rutinaria.
- El arranque normal solo valida límites administrados del runtime y nunca enumera carpetas históricas desconocidas.
- Al adoptar una versión nueva del layout sobre un runtime existente, el marcador privado obliga a ejecutar una única vez `arca:runtime:repair` antes de operar. Los arranques siguientes vuelven al camino O(1).
- Usar `arca:runtime:repair` únicamente como mantenimiento explícito, fuera de una sesión fiscal y con su confirmación literal. El comando bloquea la reparación si detecta una sesión o aprendizaje vivos o si no puede verificar sus indicadores privados.
- Medir por separado login a resumen (`chat_login_to_summary`) y confirmación a PDF validado (`emission_confirmation_to_pdf`) cuando el usuario solicite una revalidación supervisada.

## Aprendizaje durable

No considerar aprendido un flujo hasta incorporar código Playwright, pruebas, manifiesto, recuperación, registro técnico sanitizado sin artefactos crudos, roadmap y referencias sincronizadas. Leer `docs/protocolo-aprendizaje-operativo.md` al desarrollar una capacidad. Ejecutar `arca:capability:sync` y `arca:capability:check`; actualizar este archivo solo si cambian reglas o secuencias operativas generales.

No habilitar `production-hidden` salvo que el manifiesto declare simultáneamente `maturity: fast_path` y `hiddenAllowed: true` después de validación humana real.
