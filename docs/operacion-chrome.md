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
2. Guardar la credencial mediante `npm run arca:credentials:set -- "<ETIQUETA>"`.
3. Mantener el job real exclusivamente como archivo `.json` regular dentro de `%LOCALAPPDATA%\ManejoARCA\jobs\private`.
4. Partir del contrato ficticio [jobs/factura.example.json](../jobs/factura.example.json) y guardar el job real únicamente en `%LOCALAPPDATA%\ManejoARCA\jobs\private`; la sesión rechaza otras ubicaciones y enlaces.

En el job, `outputDir` es `"."` o una subcarpeta relativa de `%LOCALAPPDATA%\ManejoARCA\downloads`. Las rutas absolutas, UNC y los segmentos `..` se rechazan; un job nunca elige una carpeta arbitraria del equipo.

Las claves se leen únicamente desde el Administrador de credenciales de Windows. No deben aparecer en el chat, argumentos, archivos del repositorio, logs ni capturas.

## Preparar una factura hasta el resumen

Iniciar una sesión visible:

```powershell
npm run arca:session:start -- --issuer <CUIT_EMISOR>
```

El inicio solo es correcto si devuelve `READY_STATE=portal`. El flujo se detiene ante credencial inválida, captcha, autenticación incompleta o pantalla inesperada.

Preparar el job en esa misma sesión:

```powershell
npm run arca:session:cmd -- prepare-invoice "<RUTA_PRIVADA_JOB_V2>"
```

El comando debe llegar a `RESUMEN DE DATOS (PASO 4 DE 4)` y devolver un `preparedInvoiceId`. Antes de considerar válida la preparación, comprobar en el navegador:

- emisor y CUIT;
- punto de venta y tipo de comprobante;
- fecha de emisión, período y vencimiento;
- moneda `ARS`, comprobada en el único control visible `Moneda Extranjera` desmarcado;
- receptor, CUIT, domicilio y condición frente al IVA;
- condición de venta;
- descripción, cantidad e importe;
- subtotal e importe total.

La pantalla de resumen observada no muestra una fila separada para la fecha de emisión. Por eso ese valor se captura y compara contra el control visible `Fecha del Comprobante` en el paso 1 antes de abandonarlo; período y vencimiento se validan además por sus filas etiquetadas en el resumen.

La preparación vence a los 60 minutos. Una navegación o mutación posterior puede invalidarla. `status`, `snapshot` y `screenshot` son comandos de lectura y no la invalidan.

## Emisión pendiente de revalidación

El manifiesto vigente no incluye `emit-prepared-invoice`; por lo tanto, la versión pública actual debe detenerse en el resumen y no ejecutar la acción irreversible. La implementación se conserva para una próxima validación visible completa de generación, descarga, PDF y ledger.

La única excepción es una corrida de revalidación irreversible explícita y supervisada. Debe iniciarse desde cero en Chrome visible con:

```powershell
npm run arca:session:start -- --issuer <CUIT_EMISOR> --revalidate-irreversible invoice-services-single-item
```

El launcher y el worker validan que el manifiesto se encuentre exactamente en estado pendiente de revalidación: `automated_to_summary`, sin modo oculto, sin comando productivo de emisión y con pruebas, evidencia real, acción irreversible y confirmación declaradas. Ese modo es exclusivo, queda ligado a una capacidad concreta y no modifica ni promueve el manifiesto.

Después de preparar y mostrar el resumen completo, un nuevo mensaje humano debe contener exactamente `EMITIR`. Recién entonces se admite una sola ejecución:

```powershell
npm run arca:session:cmd -- revalidate-prepared-invoice <preparedInvoiceId> EMITIR
```

La preparación vigente, su huella de página, el job inmutable, el alcance cerrado y el ledger se verifican nuevamente antes del primer clic. Ante cualquier falla posterior, el estado queda `unknown`, la preparación se invalida y no se reintenta. Una corrida exitosa habilita la revisión humana y la posterior actualización del manifiesto; nunca lo promueve automáticamente.

Cuando una versión futura sea promovida nuevamente, la autorización válida será únicamente el texto exacto `EMITIR`, recibido después de mostrar y revisar el resumen. El CLI puede validar el literal y el `preparedInvoiceId`, pero no la autoría del mensaje. La capa agente nunca debe sintetizar `EMITIR`, convertir una paráfrasis en esa palabra ni reutilizar una autorización de otra preparación.

Si una revalidación supervisada futura mostrara `Comprobante Generado` pero fallara la obtención o validación del PDF, la operación deberá quedar en `unknown` y nunca emitirse otra vez. La recuperación seguirá exigiendo un PDF oficial y confirmación explícita:

```powershell
npm run arca:invoice:recover-pdf -- --job "<RUTA_PRIVADA_JOB_V2>" --source "<PDF_OFICIAL>" --dry-run
npm run arca:invoice:recover-pdf -- --job "<RUTA_PRIVADA_JOB_V2>" --source "<PDF_OFICIAL>" --write RECUPERAR_Y_RECONCILIAR
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
npm run arca:learn:cmd -- note "<explicación sin datos personales>"
npm run arca:learn:cmd -- checkpoint "<etiqueta genérica sin datos reales>"
npm run arca:learn:cmd -- status
npm run arca:learn:cmd -- finish
npm run arca:learn:cmd -- abort
```

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

Durante una corrida supervisada puede definirse temporalmente `ARCA_PERF_TRACE=1`. La salida solo informa nombres cerrados de etapas y milisegundos; no contiene CUIT, nombres, importes, rutas ni valores de controles. Esta medición nunca justifica eliminar validaciones fiscales o de seguridad.
