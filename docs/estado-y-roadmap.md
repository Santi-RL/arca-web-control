# Estado y roadmap del proyecto

Última actualización: 2026-07-30.

## Estado actual

ARCA Web Control es un proyecto experimental y en desarrollo. Combina un núcleo Playwright local, una sesión conversacional, un modo de aprendizaje visible, manifiestos de capacidades, una skill para agentes y un MCP `stdio`.

La única capacidad fiscal habilitada es `invoice-services-single-item`: Factura C de Servicios, moneda local `ARS` y un ítem, automatizada hasta el resumen. Su madurez vigente es `automated_to_summary`, con `hiddenAllowed: false`. La preparación exige verificar un único control visible `Moneda Extranjera` desmarcado. La implementación irreversible permanece en el código para revalidación, pero el manifiesto actual no permite ejecutarla.

La plataforma soportada es Windows 10/11. Windows Credential Manager sigue siendo el proveedor predeterminado, pero ya no es obligatorio: el usuario puede seleccionar un archivo JSON externo de solo lectura y administrar sus permisos. Todos los datos operativos privados viven fuera de Git, bajo `%LOCALAPPDATA%\ManejoARCA`.

## Base implementada

- Jobs `schemaVersion: 2`, moneda y condición frente al IVA explícitas, importes decimales exactos, CUIT canónico estricto y `operationId` idempotente por intención.
- Intake conversacional de jobs mediante JSON por `stdin`, resolución unívoca del emisor, UUID de intención privado, identificadores opacos independientes de defaults o campos fiscales opcionales, reutilización segura, escritura exclusiva y ACL privada.
- Orquestación conversacional única desde los datos completos hasta el resumen mediante `arca:invoice:prepare-chat`, con normalización de fechas e importes, reutilización de sesión y handles internos.
- Proveedores de credenciales configurables (`windows` y `json-file`) con CUIT canónico, índice no secreto para resolver nombres, rechazo de hard links, errores sanitizados y huella del archivo verificada antes y después de cargar la clave.
- Estado preparado inmutable con hash, huella de página y vencimiento de 60 minutos.
- Ledger con estados `prepared`, `emitting`, `emitted`, `failed_before_emit` y `unknown`, dueño de proceso para reconstruir preparaciones huérfanas y normalización fail-closed de emisiones huérfanas o vencidas.
- Selectores exactos, rechazo de ambigüedades y validación semántica de filas y secciones del resumen contra controles reales.
- Captura y validación del PDF, extracción local de número/CAE y reconciliación explícita de estados inciertos.
- Archivo privado por CUIT emisor con staging, publicación sin sobrescritura, nombres legibles, metadatos JSON y organización anual/mensual.
- Sesiones con lock, estado atómico, cierre controlado y detección de credenciales inválidas, captcha y expiración.
- Aprendizaje visible que omite secretos y valores de formularios, preserva Chrome ante un captcha de login hasta una reanudación humana explícita y se detiene antes de acciones irreversibles.
- Manifiestos versionados, sincronización de referencias, skill local y MCP sin herramientas genéricas de clic en producción.
- ACL privadas para runtime, aprendizaje, jobs, logs, ledger, descargas y perfiles, con marcador de migración obligatoria por versión de layout.

## Rediseño operativo del 2026-07-30

Se identificó que `ensureRuntimeLayout()` mezclaba la atestación necesaria con una reparación recursiva de todo `%LOCALAPPDATA%\ManejoARCA`. Una carpeta histórica desconocida e inaccesible podía bloquear durante minutos la creación de un job o el login, aunque no participara de la factura. La contraseña nunca fue el cuello de botella de ese incidente.

El camino normal ahora valida y protege únicamente los límites administrados y el archivo fijo de atestación, en tiempo constante respecto del volumen histórico. Un runtime anterior sin marcador se bloquea hasta completar una única reparación. Esa reparación quedó separada en `arca:runtime:repair`, requiere confirmación literal, bloquea sesiones o aprendizajes vivos y solo puede recorrer subárboles administrados; nunca inspecciona carpetas históricas desconocidas. Una exclusión mutua del sistema operativo cubre sin carreras la reparación y la publicación del indicador de un nuevo arranque. Las validaciones de desarrollo, auditorías y `autoreview` tampoco forman parte del preámbulo de una factura rutinaria.

La skill dejó de imponer un almacén único. El usuario conserva la responsabilidad sobre las claves: puede mantener Windows Credential Manager o señalar un archivo JSON externo, regular y fuera de Git. Ningún proveedor transporta la clave por argumentos, estado de sesión, MCP o logs.

## Validación visible del 2026-07-29 hasta el resumen

Se recorrió la capacidad soportada en Chrome visible hasta `RESUMEN DE DATOS (PASO 4 DE 4)`, sin emitir. Se verificaron desde la interfaz fecha de emisión, período, vencimiento, receptor, condición frente al IVA, domicilio, condición de venta, descripción y total.

El aprendizaje confirmó estas reglas generales:

- vencimiento predeterminado de cinco días corridos para Servicios;
- actividad asociada, referencia comercial y unidad de medida vacías por defecto;
- recuperación de `403 Forbidden` o sesión expirada mediante autenticación nueva, nunca reenviando el formulario;
- búsqueda del servicio sin depender de la sección `Más utilizados`;
- detención ante resultados ambiguos o pantallas inesperadas.

Toda evidencia cruda permanece fuera del repositorio.

## Emisión real controlada del 2026-07-29 y descarga directa

Una Factura C de Servicios fue emitida en Chrome visible después de mostrar el resumen y recibir la confirmación exacta `EMITIR`. ARCA mostró `Comprobante Generado` y no se repitió la acción irreversible.

La interfaz inició una descarga directa al pulsar `Imprimir...`. La estrategia anterior no capturó ese evento y dejó correctamente el ledger en `unknown`. El PDF oficial se recuperó, validó y reconcilió localmente como `emitted`, sin volver a emitir. Los identificadores, el PDF, su hash y el ledger permanecen exclusivamente en el almacenamiento privado.

El código vigente escucha la descarga antes del único clic, la recibe en staging privado, valida el PDF, extrae número/CAE, calcula el hash y publica PDF más metadatos en el archivo canónico del emisor. Ese tramo nuevo todavía requiere una próxima validación visible completa; por eso `lastValidatedVisible` continúa en `false`, la madurez regresó a `automated_to_summary` y tanto la emisión como el modo oculto permanecen deshabilitados por el manifiesto.

Para resolver la circularidad sin falsear la madurez, existe un carril de revalidación visible explícito. Solo puede habilitarse al iniciar una sesión exclusiva para la capacidad pendiente, exige un `preparedInvoiceId` vigente y la confirmación exacta `EMITIR`, reutiliza el mismo flujo irreversible y mantiene `unknown` como resultado terminal ante incertidumbre. Antes del primer clic reserva una atestación privada ligada a la versión del manifiesto. Una falla comprobada antes de intentar el clic permite liberar esa reserva y volver a `failed_before_emit`, siempre cerrando la sesión consumida; desde el primer intento de clic, ningún job o sesión nuevos pueden consumir una segunda acción irreversible de esa versión. Este carril no habilita la emisión productiva ni modifica el manifiesto automáticamente.

## Evaluaciones aisladas de la skill

Las evaluaciones se realizaron sin abrir ARCA, sin acceder al runtime privado y sin ejecutar acciones fiscales:

- el escenario soportado clasificó correctamente Factura C, Servicios, ARS y un ítem, con preparación únicamente hasta el resumen;
- una variante Factura A, Productos, moneda extranjera y dos ítems fue rechazada y derivada a aprendizaje visible privado;
- una paráfrasis como «dale, confirmo» fue rechazada como autorización: una futura emisión solo podrá aceptar un nuevo mensaje humano exactamente igual a `EMITIR`;
- la revisión de seguridad confirmó CUIT de once dígitos exactos, moneda explícita, aislamiento de pestañas, frame principal y URL estable en aprendizaje, y ausencia de inferencias fiscales en la migración.

Estas evaluaciones comprueban interpretación y fail-closed; no sustituyen la próxima revalidación visible del tramo irreversible.

## Controles locales de aceptación

Antes de publicar o promover una capacidad deben aprobarse:

- `npm run validate:public`;
- `npm run validate:skill`;
- `npm run typecheck`;
- `npm test`;
- `npm audit --audit-level=high`;
- `npm run arca:capability:check`;
- `npm run mcp:smoke`;
- revisión de seguridad y `autoreview` sin hallazgos accionables pendientes.

Las pruebas automatizadas usan fixtures ficticios o una web local simulada; no ejecutan acciones fiscales reales.

## Validación del baseline saneado del 2026-07-29

Antes de recrear la historia Git pública se obtuvieron estos resultados locales:

- `npm test`: 206 pruebas aprobadas, sin fallos;
- `npm run typecheck`, `npm run arca:capability:check`, `npm run validate:skill` y `npm run mcp:smoke`: aprobados;
- `quick_validate.py` oficial de `skill-creator`: skill válida;
- `npm audit --audit-level=high`: 0 vulnerabilidades;
- `git diff --check`: aprobado;
- `autoreview` con GPT-5.6 Sol y razonamiento alto: dos pasadas, 0 hallazgos accionables; revisión de secretos limpia.

El validador público no encontró incidencias en el árbol saneado y bloqueó únicamente objetos de la historia Git local anterior. Esa historia se conserva en un respaldo privado y debe sustituirse por un baseline nuevo antes de cualquier publicación.

## Próximos hitos

1. Completar una nueva corrida visible de la captura automática del PDF y verificar archivo por emisor, metadatos, ledger, número, CAE y hash.
2. Medir al menos cinco corridas humanas y cinco automatizadas para fijar presupuestos de login a resumen y confirmación a PDF.
3. Evaluar `fast_path` solamente después de evidencia repetida y aprobación humana; `hiddenAllowed` no cambia de forma automática.
4. Aprender y validar la consulta de comprobantes emitidos antes de exponer `arca_query_issued_invoices`.
5. Incorporar otros tipos de comprobante, conceptos o múltiples ítems únicamente como capacidades separadas y supervisadas.

## Preparación para publicación pública

El repositorio público debe nacer desde una historia Git limpia y sin datos privados. No se debe publicar la historia local anterior, aunque los archivos actuales estén saneados. El baseline público requiere documentación honesta, licencia Apache-2.0, plantillas de contribución, CI en Windows y validaciones automáticas de privacidad.

La creación del remoto y el primer `push` requieren aprobación humana separada. Hasta entonces, toda preparación permanece local.
