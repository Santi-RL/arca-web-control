# Protocolo de aprendizaje operativo

Este protocolo convierte una operación nueva o una variante de ARCA en una capacidad reproducible. El aprendizaje nunca queda solamente en el chat.

## Clasificación

- `known`: existe comando estable y manifiesto aplicable.
- `variant`: cambia algún dato, control o pantalla respecto de una capacidad conocida.
- `new`: no existe flujo ni selector confiable.
- `irreversible`: puede emitir, presentar, pagar, enviar, confirmar o modificar datos fiscales.

Toda variante irreversible se trata como nueva hasta llegar a un resumen verificable.

## Recorrido híbrido visible

1. Leer roadmap, operación Chrome, este protocolo y el manifiesto relacionado.
2. Iniciar `arca:learn:start` con emisor, slug e intención explícita.
3. Completar login y captcha con intervención humana cuando corresponda; el registro empieza después del login.
4. El dueño puede interactuar directamente o guiar al agente por chat.
5. El agente puede usar `inspect`, `click-exact`, `select-exact`, `fill-input`, `check-exact` y `press`. Si hay varias pestañas, debe usar `inspect <índice-pestaña>` y elegir una explícitamente. Cada mutación queda ligada a esa página y requiere el `inspectionId` de un solo uso producido inmediatamente antes; cualquier cambio de URL, DOM o estado del formulario obliga a reinspeccionar.
6. Registrar `note` y `checkpoint` en puntos críticos.
7. Detenerse ante controles ambiguos, pantallas inesperadas o acciones irreversibles.
8. Ejecutar `finish` para generar un candidato privado. No copiar artefactos crudos al repositorio. Si el recorrido no debe conservarse, ejecutar `npm run arca:learn:cmd -- abort`: finaliza de forma segura sin generar candidato.

El registrador guarda URL sin query, clics, cambios de select, checks, navegación y metadatos accesibles. No registra valores de inputs, teclas, portapapeles, contraseñas, cookies, tokens, storage ni red. Las capturas ocultan controles de formulario. Las notas escritas por el operador son artefactos privados y no se anonimizan automáticamente: nunca deben contener claves, tokens, CUIT, datos de clientes ni otros secretos.

Los comandos híbridos usan coincidencias exactas y solo mutan pantallas ARCA conocidas previas al resumen. El recorder ignora páginas ajenas a los orígenes oficiales permitidos del Portal y RCEL. `inspect` nunca devuelve valores, omite campos password y solo informa longitudes. `fill-input` recibe el valor exclusivamente por stdin y lo redacta en respuestas y artefactos. El aprendizaje bloquea clics, submits y textos irreversibles conocidos; esta barrera léxica es una defensa complementaria, no una autorización para avanzar. Un control nuevo, ambiguo, sin nombre accesible o basado solo en un icono exige detenerse. `press` solo admite `Tab` sobre un input seguro o `Escape`. En una pantalla nueva o en el resumen, el agente no debe mutar controles; la observación manual continúa bajo responsabilidad y supervisión humana, siempre antes de cualquier acción irreversible.

## Madurez

- `observed`: pantalla vista, sin automatización confiable.
- `assisted`: operación visible paso a paso.
- `automated_to_summary`: carga reproducible hasta resumen.
- `controlled_irreversible`: acción final con confirmación exacta y evidencia.
- `fast_path`: flujo repetido, documentado y apto para mínima intervención.

Solo `fast_path` puede declarar `hiddenAllowed: true`, después de una corrida real visible aprobada.

## Definición de aprendizaje completo

1. Incorporar un comando o flujo Playwright rígido.
2. Agregar fixtures y pruebas, incluidos desvíos y recuperación.
3. Crear o actualizar el manifiesto en `config/capabilities`.
4. Ejecutar `arca:capability:sync` y `arca:capability:check`.
5. Actualizar `docs/estado-y-roadmap.md` con evidencia.
6. Actualizar la skill si cambian reglas generales; sincronizar siempre sus referencias.
7. Ejecutar seguridad, `npm test`, `typecheck`, `npm audit` y `autoreview`.
8. Realizar la primera corrida visible con validación humana.

Si falta un punto, asignar únicamente la madurez que la evidencia disponible permita. `automated_to_summary` exige que todo el recorrido hasta el resumen sea reproducible y esté probado; `controlled_irreversible` exige además una validación visible vigente de la acción final y su evidencia. Nunca promover automáticamente.

## Recuperación

- Captcha: pausar y solicitar intervención humana.
- `403 Forbidden` o sesión expirada: no reenviar el formulario. Finalizar el tramo con evidencia, autenticar nuevamente y reconstruir el borrador desde el último checkpoint lógico.
- Selector ambiguo o campo cambiado: capturar estado, no elegir por parecido y actualizar bajo supervisión.
- Acción irreversible iniciada sin confirmación de resultado: marcar `unknown`, bloquear reintento y consultar ARCA.
- Error antes del primer clic irreversible: registrar `failed_before_emit`; puede prepararse nuevamente con el mismo `operationId`.

## Registro durable

El manifiesto es la fuente de verdad de madurez, comandos, acción irreversible, confirmación, recuperación, evidencia y última validación. `docs/capacidades.md` y la referencia de la skill son generadas; no editarlas manualmente.
