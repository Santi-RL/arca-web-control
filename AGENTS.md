# AGENTS.md

Este proyecto opera la web de ARCA con Playwright bajo supervisión humana. El CLI es el motor auditable; la skill y el MCP son capas superiores. Los Web Services oficiales de ARCA están fuera de alcance.

## Antes de operar o cambiar el sistema

Para una operación rutinaria conocida, leer `.agents/skills/arca-web-control/SKILL.md` y solo las referencias que esa skill indique para el pedido. Al cambiar el sistema, aprender una variante o promover una capacidad, leer además `docs/estado-y-roadmap.md`, `docs/operacion-chrome.md`, `docs/protocolo-aprendizaje-operativo.md` y `docs/capacidades.md`.

## Rutas obligatorias

- Resolución de emisor: cuando el selector es un nombre, los comandos canónicos consultan el índice local no secreto antes de crear jobs, logs, workers o Chrome. Si hace falta resolver cualquier selector de forma independiente, usar `arca:issuer:resolve`; una sugerencia por typo, orden o segundo nombre omitido siempre requiere confirmación humana y nunca carga la clave.
- Factura con datos recibidos por chat: usar `arca:invoice:prepare-chat` por `stdin`; esa operación valida los datos, crea o reutiliza el job privado idempotente, inicia o reutiliza Chrome visible y devuelve el resumen sin exponer handles internos.
- Login o diagnóstico de bajo nivel: `npm run arca:session:start -- --issuer <cuit>`, exigir `READY_STATE=portal` y continuar sobre esa misma sesión con `arca:session:cmd`.
- Navegación: actuar desde la pantalla actual. No reiniciar, volver al portal, abrir URLs directas ni crear scripts temporales salvo pedido explícito.
- Factura individual: `prepare-invoice <job-v2>`; mostrar el resumen y conservar `preparedInvoiceId`. La versión vigente se detiene allí: el manifiesto no habilita la emisión.
- Intake de bajo nivel: `arca:job:create` sigue disponible mediante JSON por `stdin`; nunca construir jobs reales dentro de Git ni pasar sus campos como argumentos.
- Revalidación irreversible visible: únicamente cuando el objetivo explícito sea revalidar una implementación ya probada pero pendiente, iniciar `arca:session:start` con `--revalidate-irreversible <capability-id>`. Después del resumen y de un nuevo mensaje humano exactamente igual a `EMITIR`, usar una sola vez `revalidate-prepared-invoice <preparedInvoiceId> EMITIR`. Este carril no promueve el manifiesto ni habilita producción u oculto.
- Emisión futura: solo si un manifiesto promocionado incluye `emit-prepared-invoice`, ejecutar `emit-prepared-invoice <preparedInvoiceId> EMITIR` después de recibir la confirmación humana exacta en ese momento.
- Operación nueva o variante: usar Chrome visible y `arca:learn:start`. `finish` produce un candidato privado, nunca una capacidad automatizada por sí solo.
- Cierre: usar `npm run arca:session:stop`.

## Seguridad fiscal

- No imprimir, registrar ni incorporar a Git claves, cookies, tokens, storage o perfiles. El usuario elige el proveedor de credenciales y asume la protección del almacén elegido; Windows es el predeterminado y `json-file` permite señalar un archivo externo administrado por el usuario. El CUIT es la identidad única y el nombre solo resuelve si identifica exactamente un contribuyente.
- Los nombres descriptivos y CUIT del índice configurado son metadatos no secretos accesibles para su usuario: pueden mostrarse como candidatos o listarse cuando el usuario lo solicite. Nunca incluir con ellos claves, rutas del proveedor, huellas, registros internos ni material de sesión.
- La importación CSV se ejecuta únicamente desde `%LOCALAPPDATA%\ManejoARCA\private-import`: nunca adjuntar el archivo al chat, incorporarlo a Git, pasarlo como argumento ni registrar filas o secretos.
- No resolver ni automatizar captchas. Pausar y pedir intervención humana; reanudar la misma sesión únicamente mediante `resume-authentication` después de un nuevo mensaje del usuario.
- Fuera del carril explícito de revalidación irreversible visible, no emitir en la versión vigente. Si una versión futura vuelve a habilitar la acción, no emitir sin confirmación humana exacta `EMITIR`.
- Ante captcha, selector ambiguo, campo inesperado, pantalla distinta o estado `unknown`, detenerse, capturar evidencia y consultar al usuario. Ante `403` o sesión expirada, no reenviar el formulario: renovar la autenticación y reconstruir el borrador. No adivinar equivalencias.
- Mantener jobs reales, logs, perfiles, capturas, aprendizaje y ledger en `%LOCALAPPDATA%\ManejoARCA`, nunca en Git.
- No ejecutar `takeown`, elevación, recorridos históricos ni `arca:runtime:repair` en el camino operativo normal. La reparación de ACL es mantenimiento explícito y se limita a subárboles administrados.
- Un runtime creado por una versión anterior carece del marcador de layout y debe pasar una única vez por `arca:runtime:repair` antes de volver a operar; no eludir ese bloqueo ni crear el marcador manualmente.
- Archivar PDFs y metadatos únicamente bajo `downloads\Emisores\<CUIT formateado - nombre>\Comprobantes Emitidos\<AAAA>\<MM>`. Resolver siempre por CUIT, crear carpetas solo al publicar un artefacto y no sobrescribir colisiones.
- `production-hidden` solo se admite si el manifiesto declara `maturity: fast_path` y `hiddenAllowed: true`. No modificar esa condición manualmente para saltear validaciones.

## Aprendizaje completo

Un aprendizaje o cambio de implementación no está completo hasta incorporar: flujo Playwright; pruebas; manifiesto; recuperación; evidencia visible; `arca:capability:sync`; `arca:capability:check`; roadmap; referencias de la skill; revisión de seguridad; `typecheck`; tests; `npm audit`; `autoreview`; y aprobación humana de la primera corrida visible. Estas validaciones son de desarrollo y no se ejecutan antes de cada factura rutinaria. Actualizar `SKILL.md` si cambian reglas generales, no por cada selector.

## Revisión

Usar `security-best-practices` al tocar login, credenciales, sesiones, perfiles, emisión, selectores o datos fiscales. Ejecutar `autoreview` al cerrar cambios no triviales y revisar manualmente cada finding. Mantener toda documentación de usuario en español profesional, con tildes, `ñ` y signos de apertura.
