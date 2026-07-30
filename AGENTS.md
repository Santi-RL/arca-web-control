# AGENTS.md

Este proyecto opera la web de ARCA con Playwright bajo supervisión humana. El CLI es el motor auditable; la skill y el MCP son capas superiores. Los Web Services oficiales de ARCA están fuera de alcance.

## Antes de operar o cambiar el sistema

Leer `docs/estado-y-roadmap.md`, `docs/operacion-chrome.md`, `docs/protocolo-aprendizaje-operativo.md` y `docs/capacidades.md`. Para operar como agente, leer también `.agents/skills/arca-web-control/SKILL.md`.

## Rutas obligatorias

- Login conversacional: `npm run arca:session:start -- --issuer <cuit>`, exigir `READY_STATE=portal` y continuar sobre esa misma sesión con `arca:session:cmd`.
- Navegación: actuar desde la pantalla actual. No reiniciar, volver al portal, abrir URLs directas ni crear scripts temporales salvo pedido explícito.
- Factura individual: `prepare-invoice <job-v2>`; mostrar el resumen y conservar `preparedInvoiceId`. La versión vigente se detiene allí: el manifiesto no habilita la emisión.
- Intake conversacional: crear el job con `arca:job:create` mediante JSON por `stdin`; usar el `JOB_HANDLE` opaco devuelto y nunca construir jobs reales dentro de Git ni pasar sus campos como argumentos.
- Revalidación irreversible visible: únicamente cuando el objetivo explícito sea revalidar una implementación ya probada pero pendiente, iniciar `arca:session:start` con `--revalidate-irreversible <capability-id>`. Después del resumen y de un nuevo mensaje humano exactamente igual a `EMITIR`, usar una sola vez `revalidate-prepared-invoice <preparedInvoiceId> EMITIR`. Este carril no promueve el manifiesto ni habilita producción u oculto.
- Emisión futura: solo si un manifiesto promocionado incluye `emit-prepared-invoice`, ejecutar `emit-prepared-invoice <preparedInvoiceId> EMITIR` después de recibir la confirmación humana exacta en ese momento.
- Operación nueva o variante: usar Chrome visible y `arca:learn:start`. `finish` produce un candidato privado, nunca una capacidad automatizada por sí solo.
- Cierre: usar `npm run arca:session:stop`.

## Seguridad fiscal

- No recibir ni imprimir claves, cookies, tokens, storage o perfiles. El CUIT es la identidad única: las credenciales canónicas viven como `ManejoARCA/CUIT/<cuit>` y el nombre es solo una etiqueta no única. `.env.local` y el esquema legacy son solo vías de migración temporal.
- La importación CSV se ejecuta únicamente desde `%LOCALAPPDATA%\ManejoARCA\private-import`: nunca adjuntar el archivo al chat, incorporarlo a Git, pasarlo como argumento ni registrar filas o secretos.
- No resolver ni automatizar captchas. Pausar y pedir intervención humana.
- No emitir en la versión vigente. Si una versión futura vuelve a habilitar la acción, no emitir sin confirmación humana exacta `EMITIR`.
- Ante captcha, selector ambiguo, campo inesperado, pantalla distinta o estado `unknown`, detenerse, capturar evidencia y consultar al usuario. Ante `403` o sesión expirada, no reenviar el formulario: renovar la autenticación y reconstruir el borrador. No adivinar equivalencias.
- Mantener jobs reales, logs, perfiles, capturas, aprendizaje y ledger en `%LOCALAPPDATA%\ManejoARCA`, nunca en Git.
- Archivar PDFs y metadatos únicamente bajo `downloads\Emisores\<CUIT formateado - nombre>\Comprobantes Emitidos\<AAAA>\<MM>`. Resolver siempre por CUIT, crear carpetas solo al publicar un artefacto y no sobrescribir colisiones.
- `production-hidden` solo se admite si el manifiesto declara `maturity: fast_path` y `hiddenAllowed: true`. No modificar esa condición manualmente para saltear validaciones.

## Aprendizaje completo

Un aprendizaje no está completo hasta incorporar: flujo Playwright; pruebas; manifiesto; recuperación; evidencia visible; `arca:capability:sync`; `arca:capability:check`; roadmap; referencias de la skill; revisión de seguridad; `typecheck`; tests; `npm audit`; `autoreview`; y aprobación humana de la primera corrida visible. Actualizar `SKILL.md` si cambian reglas generales, no por cada selector.

## Revisión

Usar `security-best-practices` al tocar login, credenciales, sesiones, perfiles, emisión, selectores o datos fiscales. Ejecutar `autoreview` al cerrar cambios no triviales y revisar manualmente cada finding. Mantener toda documentación de usuario en español profesional, con tildes, `ñ` y signos de apertura.
