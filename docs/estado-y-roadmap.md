# Estado y roadmap del proyecto

Última actualización: 2026-08-01.

## Estado actual

ARCA Web Control es un proyecto experimental y en desarrollo. Combina un núcleo Playwright local, una sesión conversacional, un modo de aprendizaje visible, manifiestos de capacidades, una skill para agentes y un MCP `stdio`.

Las capacidades fiscales declaradas hasta el resumen son `invoice-services-single-item`, para un receptor identificado por CUIT, e `invoice-services-single-item-consumidor-final-anonimo`, para Consumidor Final sin identificar. Ambas se limitan a Factura C de Servicios, moneda local `ARS`, un ítem, Chrome visible y madurez `automated_to_summary`, con `hiddenAllowed: false`. La preparación exige verificar un único control visible `Moneda Extranjera` desmarcado. La segunda capacidad completó su revalidación irreversible visible, pero no fue promovida; los manifiestos no habilitan emisión productiva ni ejecución oculta.

La plataforma soportada es Windows 10/11. Windows Credential Manager sigue siendo el proveedor predeterminado, pero ya no es obligatorio: el usuario puede seleccionar un archivo JSON externo de solo lectura y administrar sus permisos. Todos los datos operativos privados viven fuera de Git, bajo `%LOCALAPPDATA%\ManejoARCA`.

## Base implementada

- Jobs `schemaVersion: 2`, moneda y condición frente al IVA explícitas, importes decimales exactos, CUIT canónico estricto y `operationId` idempotente por intención. La ausencia del discriminante conserva el receptor identificado histórico; `recipientKind: "anonymous-final-consumer"` declara de forma inequívoca el Consumidor Final sin CUIT, nombre ni domicilio.
- Intake conversacional de jobs mediante JSON por `stdin`, resolución unívoca del emisor, UUID de intención privado, identificadores opacos independientes de defaults o campos fiscales opcionales, reutilización segura, escritura exclusiva y ACL privada.
- Orquestación conversacional única desde los datos completos hasta el resumen mediante `arca:invoice:prepare-chat`, con normalización de fechas e importes, reutilización de sesión y handles internos.
- Proveedores de credenciales configurables (`windows` y `json-file`) con CUIT canónico, índice no secreto para resolver nombres, rechazo de hard links, errores sanitizados y huella del archivo verificada antes y después de cargar la clave.
- Preflight de nombres de emisor antes de jobs, logs, workers o Chrome, con resolución exacta y candidatos no secretos para variantes acotadas; ninguna sugerencia carga una clave ni inicia sesión sin confirmación humana.
- Estado preparado inmutable con hash, huella de página y vencimiento de 60 minutos.
- Ledger con estados `prepared`, `emitting`, `emitted`, `failed_before_emit` y `unknown`, dueño de proceso para reconstruir preparaciones huérfanas y normalización fail-closed de emisiones huérfanas o vencidas.
- Selectores exactos, rechazo de ambigüedades y validación semántica de filas y secciones del resumen contra controles reales. La selección de representado admite orden invertido y un único segundo nombre o apellido omitido solo cuando ARCA asocia el nombre canónico al CUIT exacto y existe un único control coincidente. Para el receptor identificado se exige un CUIT visible exacto y una razón social con orden y forma societaria invariantes; solo se toleran diferencias de formato y una única errata acotada en un término largo. Para el receptor anónimo se exige evidencia positiva de IVA `Consumidor Final` y controles y filas de identidad vacíos.
- Selección exacta del punto de venta y validación posterior del selector dependiente de comprobantes: el domicilio compartido no determina los tipos disponibles y solo una opción habilitada e inequívoca `Factura C` permite continuar.
- Captura y validación del PDF, extracción local de número/CAE y reconciliación explícita de estados inciertos.
- Archivo privado por CUIT emisor con staging, publicación sin sobrescritura, nombres legibles, metadatos JSON y organización anual/mensual.
- Sesiones con lock, estado atómico, cierre controlado y detección de credenciales inválidas, captcha y expiración.
- Aprendizaje visible que omite secretos y valores de formularios, preserva Chrome ante un captcha de login hasta una reanudación humana explícita y se detiene antes de acciones irreversibles.
- Manifiestos versionados, sincronización de referencias, skill local y MCP sin herramientas genéricas de clic en producción.
- ACL privadas para runtime, aprendizaje, jobs, logs, ledger, descargas y perfiles, con marcador de migración obligatoria por versión de layout.

## Rediseño operativo del 2026-07-30

Se identificó que `ensureRuntimeLayout()` mezclaba la atestación necesaria con una reparación recursiva de todo `%LOCALAPPDATA%\ManejoARCA`. Una carpeta histórica desconocida e inaccesible podía bloquear durante minutos la creación de un job o el login, aunque no participara de la factura. La contraseña nunca fue el cuello de botella de ese incidente.

El camino normal ahora valida y protege únicamente los límites administrados y el archivo fijo de atestación, en tiempo constante respecto del volumen histórico. Un runtime anterior sin marcador se bloquea hasta completar una única reparación. Esa reparación quedó separada en `arca:runtime:repair`, requiere confirmación literal, bloquea sesiones o aprendizajes vivos y solo puede recorrer subárboles administrados; nunca inspecciona carpetas históricas desconocidas. Una exclusión mutua del sistema operativo cubre sin carreras la reparación y la publicación del indicador de un nuevo arranque. Las validaciones, auditorías y revisiones de desarrollo tampoco forman parte del preámbulo de una factura rutinaria.

La skill dejó de imponer un almacén único. El usuario conserva la responsabilidad sobre las claves: puede mantener Windows Credential Manager o señalar un archivo JSON externo, regular y fuera de Git. Ningún proveedor transporta la clave por argumentos, estado de sesión, MCP o logs.

## Resolución rápida de emisores del 2026-07-31

La resolución por nombre del emisor quedó separada como preflight local y se incorporó al launcher de aprendizaje antes de crear logs, workers o Chrome. El índice de nombre y CUIT se trata explícitamente como metadato no secreto accesible para su usuario; solo las claves y el material interno continúan ocultos.

Una coincidencia exacta puede continuar con el CUIT canónico. Un error tipográfico de un carácter en un término largo, un orden invertido o la omisión de un único segundo nombre solo producen candidatos visibles y siempre exigen confirmación humana. Los cambios de forma societaria, los CUIT inválidos, las ambigüedades y las variantes más amplias siguen bloqueados. La prueba local real del índice respondió en menos de un segundo de trabajo interno y no abrió Chrome; el tiempo total también incluye el arranque del CLI.

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

## Variante real del PDF detectada el 2026-07-31

Una revalidación visible produjo un único comprobante y descargó su PDF oficial, pero la validación automática dejó correctamente la operación en `unknown`: el total era visualmente correcto, aunque PDF.js entregaba el importe antes que la etiqueta `Importe Total` en el orden lógico de sus `TextItem`. No se repitió la acción irreversible y los artefactos crudos permanecieron en el almacenamiento privado.

La validación reconstruye ahora cada línea por las coordenadas del texto, exige una única etiqueta y un único importe monetario posterior en esa línea visual, y rechaza cualquier geometría ambigua. Las pruebas locales cubren el orden lógico invertido, un total incorrecto en esa variante, etiquetas duplicadas y dos importes en una misma línea. La reconciliación canónica de esta operación y una revalidación visible integral de la versión corregida continúan pendientes; por eso no se promueven la madurez, la emisión productiva ni el modo oculto.

## Aprendizaje visible de Consumidor Final anónimo y alcance por punto de venta del 2026-07-31

Un recorrido visible y supervisado llegó al resumen sin emitir y confirmó dos reglas generales. Primero, los tipos de comprobante dependen del punto de venta seleccionado aunque distintos puntos compartan domicilio. La automatización debe elegir el valor exacto, esperar y volver a inspeccionar el selector dependiente, exigir una única `Factura C` habilitada y releer ambos valores; si falta, está deshabilitada, aparece más de una vez o el estado es ambiguo, debe mostrar las opciones visibles y detenerse.

Segundo, un Consumidor Final sin identificar no se deduce de campos ausentes. Se declara mediante `recipientKind: "anonymous-final-consumer"`, solo con condición frente al IVA `Consumidor Final` y sin número de documento, nombre o domicilio. Al seleccionar esa condición, ARCA carga los tipos identificatorios y deja un único `CUIT` habilitado preseleccionado. La automatización debe esperar y releer ese default sin tocar el selector ni disparar `change`; un default distinto, vacío, duplicado o deshabilitado es una variante y bloquea. La ausencia de identidad se acepta únicamente con evidencia positiva de número, nombre y domicilio vacíos, además de un resumen sin valores de CUIT, razón social o domicilio del receptor y un PDF sin identidad receptora no vacía. Los datos y artefactos crudos usados para observar esta variante permanecen exclusivamente en el runtime privado.

El recorrido también confirmó que `Email` y `Comprobantes Asociados` son optativos. La capacidad vigente no modela valores para esos campos: deben quedar sin completar, con evidencia visible de email vacío y de todos los campos de comprobantes asociados vacíos. En el resumen, ARCA representa `Email` sin valor y `Comprobantes Asociados` con `-`; cualquier valor solicitado por el usuario constituye una variante todavía no modelada ni aprendida y no debe completarse por inferencia.

La variante se mantiene como una capacidad separada, `invoice-services-single-item-consumidor-final-anonimo`, con madurez `automated_to_summary`, ejecución visible, `hiddenAllowed: false` y sin comando productivo de emisión. Su posterior revalidación visible quedó registrada de manera independiente. El aprendizaje y una corrida exitosa no promueven automáticamente la capacidad.

## Variante del PDF de Consumidor Final anónimo detectada el 2026-07-31

Una corrida visible ejecutó una sola vez la acción irreversible y obtuvo el PDF oficial, pero el validador exigía que el bloque del receptor incluyera explícitamente la etiqueta `CUIT`. El documento observado omitía esa etiqueta para el Consumidor Final anónimo, por lo que la operación quedó correctamente en `unknown`, no se intentó emitir nuevamente y requiere reconciliación del PDF ya obtenido. Un dry-run de recuperación confirmó que, en esa representación, ARCA antepone el marcador genérico exacto `Doc.: -` a la fila `Razón Social` vacía.

El aprendizaje general es que cada página o copia admite dos representaciones cerradas del receptor anónimo. Puede existir una única etiqueta `CUIT` sin valor en la misma fila de `Razón Social` vacía y sin prefijo adicional. Si no existe esa etiqueta, debe aparecer obligatoriamente el marcador exacto `Doc.: -` inmediatamente antes de `Razón Social`; no se acepta una fila sin ninguno de los dos marcadores. Cualquier otro tipo o valor documental conserva `unknown`. Ambas formas requieren razón social y domicilio vacíos, IVA `Consumidor Final`, un bloque receptor único y contiguo y que el único CUIT no vacío de la página corresponda al emisor.

El mismo documento puede contener varias copias oficiales. Todas deben validarse por separado contra el job, con exactamente una ocurrencia etiquetada del número de comprobante y una del CAE por página, y resolver idénticos esos valores y los demás datos fiscales. La repetición del mismo CUIT emisor una vez por copia representa una única identidad y no es un duplicado global; dentro de cada página siguen bloqueados una etiqueta repetida en el mismo rol o sección y cualquier CUIT adicional. En ese momento, la reconciliación permaneció pendiente hasta incorporar y verificar este cierre por página o copia. Esta corrección no promovió la madurez, no habilitó emisión productiva ni permitió modo oculto.

La medición histórica entre la confirmación y la obtención del PDF se reconstruyó en aproximadamente 4,121 segundos a partir de los tiempos privados de la corrida. El registro de rendimiento estaba ubicado después del analizador y podía perder la medición cuando la validación fallaba; el orden quedó corregido para cerrar esa etapa inmediatamente después de guardar la descarga privada y antes de analizar o validar el documento. No se incorporaron marcas de tiempo ni artefactos crudos al repositorio.

## Revalidación visible completa de Consumidor Final anónimo del 2026-08-01

Se completó una corrida visible y supervisada de `invoice-services-single-item-consumidor-final-anonimo` desde la preparación hasta el archivo canónico. La acción irreversible se ejecutó exactamente una vez, después de la confirmación humana exacta, y no se reintentó durante la recuperación.

El PDF oficial contenía tres páginas o copias. Cada una se validó íntegramente contra el mismo job, con unicidad interna de comprobante y CAE, identidad fiscal cerrada y datos coincidentes entre copias. La recuperación canónica publicó PDF y metadatos sin sobrescribir y reconcilió el ledger a `emitted`. Los datos fiscales, identificadores, hash, rutas y artefactos crudos permanecen exclusivamente en el runtime privado.

El manifiesto registra esta validación visible, pero conserva madurez `automated_to_summary`, `hiddenAllowed: false` y solo `prepare-invoice`; no incorpora `emit-prepared-invoice`. Evaluar una promoción es un paso humano separado y no forma parte de este hito.

## Evaluaciones aisladas de la skill

Las evaluaciones se realizaron sin abrir ARCA, sin acceder al runtime privado y sin ejecutar acciones fiscales:

- el escenario soportado clasificó correctamente Factura C, Servicios, ARS y un ítem, con preparación únicamente hasta el resumen;
- una variante Factura A, Productos, moneda extranjera y dos ítems fue rechazada y derivada a aprendizaje visible privado;
- una paráfrasis como «dale, confirmo» fue rechazada como autorización: una futura emisión solo podrá aceptar un nuevo mensaje humano exactamente igual a `EMITIR`;
- la revisión de seguridad confirmó CUIT de once dígitos exactos, moneda explícita, aislamiento de pestañas, frame principal y URL estable en aprendizaje, y ausencia de inferencias fiscales en la migración.

Estas evaluaciones comprueban interpretación y fail-closed; no sustituyen la evidencia visible registrada ni futuras corridas repetidas requeridas para una promoción.

## Controles locales de aceptación

Antes de publicar o promover una capacidad deben aprobarse:

- `npm run validate:public`;
- `npm run validate:skill`;
- `npm run typecheck`;
- `npm test`;
- `npm audit --audit-level=high`;
- `npm run arca:capability:check`;
- `npm run mcp:smoke`;
- revisión de seguridad y revisión independiente de código sin hallazgos accionables pendientes.

Las pruebas automatizadas usan fixtures ficticios o una web local simulada; no ejecutan acciones fiscales reales.

## Validación del baseline saneado del 2026-07-29

Antes de recrear la historia Git pública se obtuvieron estos resultados locales:

- `npm test`: 206 pruebas aprobadas, sin fallos;
- `npm run typecheck`, `npm run arca:capability:check`, `npm run validate:skill` y `npm run mcp:smoke`: aprobados;
- validación estructural de la skill: aprobada;
- `npm audit --audit-level=high`: 0 vulnerabilidades;
- `git diff --check`: aprobado;
- revisión independiente de código en dos pasadas, sin hallazgos accionables; revisión de secretos limpia.

El validador público no encontró incidencias en el árbol saneado y bloqueó únicamente objetos de la historia Git local anterior. Esa historia se conserva en un respaldo privado y debe sustituirse por un baseline nuevo antes de cualquier publicación.

## Próximos hitos

1. Revisar, con aprobación humana separada, si la evidencia disponible justifica promover `invoice-services-single-item-consumidor-final-anonimo` a `controlled_irreversible`; no habilitar emisión productiva como parte del registro de este hito.
2. Medir al menos cinco corridas humanas y cinco automatizadas para fijar presupuestos de login a resumen y confirmación a PDF.
3. Evaluar `fast_path` solamente después de evidencia repetida y aprobación humana; `hiddenAllowed` no cambia de forma automática.
4. Aprender y validar la consulta de comprobantes emitidos antes de exponer `arca_query_issued_invoices`.
5. Incorporar otros tipos de comprobante, conceptos o múltiples ítems únicamente como capacidades separadas y supervisadas.

## Preparación para publicación pública

El repositorio público debe nacer desde una historia Git limpia y sin datos privados. No se debe publicar la historia local anterior, aunque los archivos actuales estén saneados. El baseline público requiere documentación honesta, licencia Apache-2.0, plantillas de contribución, CI en Windows y validaciones automáticas de privacidad.

La creación del remoto y el primer `push` requieren aprobación humana separada. Hasta entonces, toda preparación permanece local.
