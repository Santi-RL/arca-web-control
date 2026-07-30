# Operación supervisada con Chrome y Playwright

Este documento describe el uso vigente del proyecto. El navegador automatizado debe permanecer visible y la persona operadora conserva el control de toda acción fiscal irreversible.

## Alcance operativo actual

La única capacidad automatizada hasta el resumen es `invoice-services-single-item`:

- Factura C;
- concepto `Servicios`;
- moneda local `ARS`, con `Moneda Extranjera` visible y desmarcada;
- un solo ítem;
- ejecución en Windows;
- emisión actualmente deshabilitada hasta revalidación visible.

Cualquier otro comprobante, concepto, moneda, cantidad de ítems o consulta debe tratarse como una capacidad nueva. Puede observarse con el modo de aprendizaje, pero no debe ejecutarse de forma irreversible.

El modo `production-hidden` está deshabilitado. No se automatizan captchas ni se abren URLs internas de ARCA para saltear navegación.

## Preparación local

1. Instalar dependencias reproducibles con `npm ci` y el navegador con `npx playwright install chromium`.
2. Al actualizar desde una versión anterior sobre un runtime existente, ejecutar una única vez `npm run arca:runtime:repair -- --write REPARAR_RUNTIME`, fuera de toda sesión fiscal. El marcador privado evita repetirla y el comando omite carpetas históricas desconocidas.
3. Elegir el proveedor de credenciales. Sin configuración se usa Windows; `npm run arca:credentials:provider -- set json-file "<RUTA_ABSOLUTA>"` selecciona un JSON externo administrado por el usuario.
4. Si los datos llegan por chat, usar `arca:invoice:prepare-chat` por `stdin`; el comando crea o reutiliza el job idempotente dentro de `%LOCALAPPDATA%\ManejoARCA\jobs\private` y conserva el handle internamente. `arca:job:create` queda disponible para diagnóstico.
5. Partir del contrato ficticio [jobs/factura.example.json](../jobs/factura.example.json) y guardar el job real únicamente en `%LOCALAPPDATA%\ManejoARCA\jobs\private`; la sesión rechaza otras ubicaciones y enlaces.

`outputDir` es opcional. Si se omite, usa la raíz privada `downloads`; por compatibilidad puede definir una subcarpeta relativa, pero nunca una ruta absoluta, UNC o con segmentos `..`. La carpeta definitiva no se decide por factura: se genera automáticamente por CUIT emisor, tipo de artefacto, año y mes.

El usuario decide dónde proteger las claves. Windows Credential Manager es el valor predeterminado y el proveedor `json-file` admite un archivo externo regular, fuera del repositorio, que el motor no modifica. Ninguna clave debe aparecer en argumentos, archivos del repositorio, logs ni capturas.

`arca:job:create` acepta solo los campos de la Factura C de Servicios de un ítem, resuelve `issuerSelector` contra el proveedor local y fija el alcance fiscal cerrado. La capa agente crea un UUID `intentId` privado para cada solicitud comercial humana: de ese UUID se deriva el `operationId` estable, mientras que el handle incorpora además `intentRevision`. Una corrección humana anterior al primer clic conserva la intención e incrementa la revisión; un estado `unknown` o `emitted` nunca se elude cambiando datos, revisión o identificador. El hash del contenido protege cada revisión contra sustituciones. La entrada viaja por `stdin`; el comando no imprime el contenido, nombres ni CUIT y devuelve únicamente `JOB_HANDLE` y `OPERATION_ID`. Un handle puede pasarse directamente a `prepare-invoice` y siempre se resuelve dentro de `jobs\private`.

## Preparar una factura hasta el resumen desde el chat

Enviar el intake estructurado por `stdin` en una sola invocación:

```powershell
npm run arca:invoice:prepare-chat
```

La entrada acepta fechas `DD/MM/AAAA` o `AAAA-MM-DD`, importe ficticio `123.456,78` o `123456.78` y vencimiento `Default`. El comando valida antes de abrir Chrome, rechaza números que requieran redondeo, resuelve el nombre una sola vez, crea o reutiliza el job idempotente, inicia o reutiliza la sesión visible y ejecuta la preparación. Devuelve el `preparedInvoiceId` y el resumen sin imprimir el handle del job.

Para la corrida irreversible de revalidación pendiente, usar la misma operación con:

```powershell
npm run arca:invoice:prepare-chat -- --revalidate-irreversible invoice-services-single-item
```

Las primitivas siguientes se conservan para diagnóstico y recuperación.

## Preparación de bajo nivel

Iniciar una sesión visible:

```powershell
npm run arca:session:start -- --issuer <CUIT_EMISOR>
```

El inicio solo es correcto si devuelve `READY_STATE=portal`. Si devuelve `ARCA_CAPTCHA_REQUIRED`, el Chrome visible permanece abierto y la sesión queda pausada: pedir intervención humana y no reenviar el login. Únicamente después de que el usuario indique que resolvió el captcha, ejecutar `npm run arca:session:cmd -- resume-authentication`; esa reanudación opera sobre la misma sesión y vuelve a detenerse si el captcha continúa o la pantalla no es el login oficial. Una credencial incorrecta clausura la sesión sin segundo intento.

Preparar el job en esa misma sesión:

```powershell
npm run arca:session:cmd -- prepare-invoice "<JOB_HANDLE_O_RUTA_PRIVADA_JOB_V2>"
```

El comando debe llegar a `RESUMEN DE DATOS (PASO 4 DE 4)` y devolver un `preparedInvoiceId`. Antes de considerar válida la preparación, comprobar en el navegador:

- emisor y CUIT;
- punto de venta y tipo de comprobante;
- fecha de emisión, período y vencimiento;
- moneda `ARS`, comprobada en el único control visible `Moneda Extranjera` desmarcado;
- receptor, CUIT, domicilio y condición frente al IVA;
- condición de venta;
- descripción, cantidad e importe;
- precio unitario, subtotal e importe total.

La pantalla de resumen observada no muestra una fila separada para la fecha de emisión. Por eso ese valor se captura y compara contra el control visible `Fecha del Comprobante` en el paso 1 antes de abandonarlo; período y vencimiento se validan además por sus filas etiquetadas en el resumen.

La preparación vence a los 60 minutos. Una navegación o mutación posterior puede invalidarla. `status`, `snapshot` y `screenshot` son comandos de lectura y no la invalidan.

## Emisión pendiente de revalidación

El manifiesto vigente no incluye `emit-prepared-invoice`; por lo tanto, la versión pública actual debe detenerse en el resumen y no ejecutar la acción irreversible. La implementación se conserva para una próxima validación visible completa de generación, descarga, PDF y ledger.

La única excepción es una corrida de revalidación irreversible explícita y supervisada. La ruta conversacional recomendada es `arca:invoice:prepare-chat -- --revalidate-irreversible invoice-services-single-item`; para diagnóstico de bajo nivel puede iniciarse desde cero en Chrome visible con:

```powershell
npm run arca:session:start -- --issuer <CUIT_EMISOR> --revalidate-irreversible invoice-services-single-item
```

El launcher y el worker validan que el manifiesto se encuentre exactamente en estado pendiente de revalidación: `automated_to_summary`, sin modo oculto, sin comando productivo de emisión y con pruebas, evidencia real, acción irreversible y confirmación declaradas. Ese modo es exclusivo, queda ligado a una capacidad concreta y no modifica ni promueve el manifiesto.

Después de preparar y mostrar el resumen completo, un nuevo mensaje humano debe contener exactamente `EMITIR`. Recién entonces se admite una sola ejecución:

```powershell
npm run arca:session:cmd -- revalidate-prepared-invoice <preparedInvoiceId> EMITIR
```

La preparación vigente, su huella de página, el job inmutable, el alcance cerrado y el ledger se verifican nuevamente antes del primer clic. Primero se reservan de forma exclusiva el ledger y una atestación privada ligada a la versión de la capacidad. Si se comprueba una falla antes de intentar el clic, se libera la atestación, el ledger vuelve a `failed_before_emit` y la sesión consumida debe cerrarse antes de reconstruir. Desde el primer intento de clic, cualquier falla o resultado incierto queda `unknown`, la preparación se invalida y no se reintenta. En `Comprobante Generado` se exige exactamente un control visible `Imprimir...`; el listener de descarga se instala antes de su único clic y la ausencia, ambigüedad o falla detiene el flujo sin abrir una URL alternativa ni repetir la acción. Una corrida exitosa habilita la revisión humana y la posterior actualización del manifiesto; nunca lo promueve automáticamente.

## Archivo privado de comprobantes

La descarga directa se recibe primero en `downloads\.staging` mediante un nombre derivado del hash del `operationId`. Después de validar tipo, punto de venta, receptor, fecha, descripción, cantidad uno, precio unitario, subtotal e `Importe Total` contra el job, extraer un único número y CAE, comprobar la coincidencia con la pantalla y calcular SHA-256, se publica sin sobrescritura en:

```text
downloads\Emisores\20-00000000-1 - EMISOR FICTICIO\Comprobantes Emitidos\2030\06\
  EMISOR FICTICIO - FC-C - 00001-00000042.pdf
  EMISOR FICTICIO - FC-C - 00001-00000042.json
```

El CUIT es la identidad canónica. El nombre proviene del resumen verificado de ARCA y funciona solo como etiqueta: si ya existe una única carpeta con ese CUIT se reutiliza aunque la etiqueta haya cambiado; si existen varias, la operación se detiene. El JSON lateral conserva `operationId`, hash del job, emisor, tipo y código de comprobante, punto de venta, número, fecha, CAE, hash del PDF y fecha de archivo. No incluye la clave fiscal ni cookies, tokens o perfiles.

Los códigos de archivo son cerrados: `FC` para factura, `NC` para nota de crédito y `ND` para nota de débito, seguidos por la letra `A`, `B` o `C`. Esta nomenclatura no amplía la capacidad fiscal vigente: actualmente solo se opera Factura C.

La misma carpeta canónica del emisor queda preparada para futuras capacidades de descarga. Esas capacidades deberán crear sus directorios recién al guardar el primer artefacto y usar `Datos Descargados\<tipo>\AAAA\MM`; el tipo será un identificador cerrado y documentado por cada capacidad, nunca un nombre libre proveniente de la web. La estructura no se crea por el solo hecho de que el emisor exista en el proveedor de credenciales configurado.

Un mismo nombre y hash es idempotente. Un mismo nombre con PDF o metadatos diferentes se considera una colisión y nunca se sobrescribe. El ledger solo pasa a `emitted` después de publicar y verificar ambos archivos; conserva sus rutas, número, CAE y SHA-256.

Cuando una versión futura sea promovida nuevamente, la autorización válida será únicamente el texto exacto `EMITIR`, recibido después de mostrar y revisar el resumen. El CLI puede validar el literal y el `preparedInvoiceId`, pero no la autoría del mensaje. La capa agente nunca debe sintetizar `EMITIR`, convertir una paráfrasis en esa palabra ni reutilizar una autorización de otra preparación.

Si una revalidación supervisada futura mostrara `Comprobante Generado` pero fallara la obtención, validación o publicación del PDF y sus metadatos, la operación deberá quedar en `unknown` y nunca emitirse otra vez. La recuperación seguirá exigiendo un PDF oficial, la identidad del emisor conservada en el ledger y confirmación explícita:

Antes de ejecutar el comando, colocar el PDF oficial como archivo regular directamente en `%LOCALAPPDATA%\ManejoARCA\downloads\recovery-inbox`. No se aceptan rutas externas, subcarpetas, symlinks ni hard links. El recuperador copia el archivo mediante un descriptor estable a staging privado y valida, hashea y publica únicamente esa copia; `--dry-run` elimina el temporal y no deja artefactos PDF nuevos.

```powershell
npm run arca:invoice:recover-pdf -- --job "<RUTA_PRIVADA_JOB_V2>" --source "$env:LOCALAPPDATA\ManejoARCA\downloads\recovery-inbox\<PDF_OFICIAL>" --dry-run
npm run arca:invoice:recover-pdf -- --job "<RUTA_PRIVADA_JOB_V2>" --source "$env:LOCALAPPDATA\ManejoARCA\downloads\recovery-inbox\<PDF_OFICIAL>" --write RECUPERAR_Y_RECONCILIAR
```

Cerrar siempre la sesión de forma controlada:

```powershell
npm run arca:session:stop
```

## Reglas de datos para Servicios

- El job debe declarar `currency: "ARS"`. La moneda no se infiere: la omisión y cualquier otro valor se rechazan antes de navegar.
- En el paso de emisión debe existir exactamente un checkbox visible `Moneda Extranjera` y debe estar desmarcado. Si falta, está marcado o es ambiguo, la preparación se detiene.
- Si el usuario no indica vencimiento, se usan cinco días corridos después de la fecha de emisión.
- Actividad asociada, referencia comercial y unidad de medida quedan vacías por defecto.
- Una actividad solo se informa cuando el usuario la solicita y coincide con un perfil privado de régimen específico del emisor.
- Si ARCA normaliza un campo en el resumen, se verifica como salida del portal; no se presupone a partir del job.

## Aprendizaje de una capacidad nueva

El aprendizaje es visible, local y no productivo:

```powershell
npm run arca:learn:start -- --issuer <CUIT_EMISOR> --capability <slug> --intent "<objetivo>"
npm run arca:learn:cmd -- resume-authentication
npm run arca:learn:cmd -- note "<explicación sin datos personales>"
npm run arca:learn:cmd -- checkpoint "<etiqueta genérica sin datos reales>"
npm run arca:learn:cmd -- status
npm run arca:learn:cmd -- finish
npm run arca:learn:cmd -- abort
```

Si el inicio devuelve `READY_STATE=captcha` y `ARCA_CAPTCHA_REQUIRED`, Chrome y el worker permanecen abiertos pero el registrador todavía no se instala. Pedir intervención humana y no reenviar credenciales. Solo después de una confirmación nueva del usuario ejecutar `resume-authentication`: si la resolución manual ya llegó al Portal, habilita el registrador sin reenviar formularios; si continúa en el login oficial, completa como máximo esa reanudación explícita; si persiste el captcha o aparece otra pantalla, vuelve a detenerse. `ARCA_INVALID_CREDENTIALS` cierra el worker inmediatamente y no admite un segundo intento.

La persona puede interactuar manualmente o guiar al agente. El registrador no conserva valores de inputs, contraseñas, teclas, cookies, tokens, storage ni tráfico de red. Bloquea de forma estructural la pantalla terminal aprendida y usa una barrera léxica complementaria en las pantallas anteriores; un control nuevo, ambiguo o sin nombre accesible exige detenerse. Los textos de `note` y nombres de `checkpoint` son privados, se guardan literalmente y nunca deben contener datos reales ni secretos. Los artefactos crudos permanecen en `%LOCALAPPDATA%\ManejoARCA\learning` y nunca se publican. Use `abort` como salida segura si no corresponde conservar el recorrido; cierra el aprendizaje sin generar un candidato.

Para convertir un aprendizaje en una contribución, traducirlo a código general, selectores exactos, fixtures ficticios, pruebas, manifiesto, recuperación y documentación. Seguir [CONTRIBUTING.md](../CONTRIBUTING.md) y [protocolo-aprendizaje-operativo.md](protocolo-aprendizaje-operativo.md).

## Recuperación y detenciones obligatorias

- `Clave o usuario incorrecto`: cerrar el intento e informar `ARCA_INVALID_CREDENTIALS`; no reintentar automáticamente.
- Captcha: pedir intervención humana; no resolverlo ni evadirlo.
- `403 Forbidden` o sesión expirada: no reenviar el formulario; autenticar de nuevo y reconstruir el borrador.
- Selector ambiguo o pantalla distinta: capturar evidencia privada y detenerse.
- Falla antes de la primera acción irreversible: puede volver a prepararse según el ledger.
- Resultado incierto después de la primera acción irreversible: mantener `unknown` y consultar ARCA antes de cualquier otra operación.

## Diagnóstico de rendimiento

Durante una corrida supervisada puede definirse temporalmente `ARCA_PERF_TRACE=1`. La etapa agregada `chat_login_to_summary` comienza inmediatamente antes de iniciar la sesión visible y termina al recibir el resumen estructurado; el resultado devuelve `timings.loginToSummaryMs`. `emission_confirmation_to_pdf` comienza cuando el worker recibe el comando autorizado y termina al obtener y validar el PDF; el resultado exitoso devuelve `timings.confirmationToPdfMs`. La traza se escribe por `stderr` y solo informa nombres cerrados de etapas, resultado y milisegundos; no contiene CUIT, nombres, importes, rutas ni valores de controles ni corrompe la salida JSON. Esta medición nunca justifica eliminar validaciones fiscales o de seguridad.

El camino operativo normal nunca ejecuta `takeown`, UAC, `icacls /T`, migraciones, tests ni auditorías. Si las ACL de un subárbol administrado requieren saneamiento histórico, detener toda sesión fiscal y ejecutar de forma explícita:

```powershell
npm run arca:runtime:repair -- --write REPARAR_RUNTIME
```

La reparación no enumera ni modifica carpetas desconocidas bajo la raíz privada.
