# ARCA Web Control

Skill y motor local experimental para operar la interfaz web de ARCA con Playwright, trazabilidad y supervisión humana obligatoria.

> [!WARNING]
> Este proyecto está en desarrollo, no está afiliado, patrocinado ni aprobado por ARCA, AFIP ni ningún organismo público. La interfaz de ARCA puede cambiar sin aviso. Revise siempre el resumen en el navegador antes de autorizar una acción fiscal.

## Estado y alcance real

Actualmente el alcance implementado se limita a una única capacidad fiscal:

- Factura C.
- Concepto `Servicios`.
- Moneda local `ARS`, verificada en ARCA mediante `Moneda Extranjera` desmarcada.
- Un solo ítem.
- Ejecución visible en Windows.
- Preparación automatizada hasta el resumen.
- Implementación de emisión y recuperación del PDF conservada para revalidación, pero deshabilitada por el manifiesto vigente.

La capacidad se encuentra en madurez `automated_to_summary`. Hubo una emisión real controlada con una versión anterior del tramo de descarga, pero la captura automática vigente del PDF todavía requiere una nueva validación visible. Por ese motivo, `lastValidatedVisible` permanece en `false`; `emit-prepared-invoice` y el modo oculto están deshabilitados por el manifiesto.

No están soportados actualmente:

- otros tipos de factura, notas de crédito o débito, recibos ni comprobantes equivalentes;
- facturas de productos, múltiples ítems o lotes;
- consultas productivas de comprobantes emitidos;
- operación desatendida o `production-hidden`;
- automatización de captchas;
- macOS o Linux;
- Web Services oficiales de ARCA;
- asesoramiento contable, impositivo o legal.

## Plataforma

La plataforma compatible es exclusivamente **Windows 10 y Windows 11**. El desarrollo y las pruebas se realizan con Node.js 24, PowerShell y Playwright local. No se afirma compatibilidad con otros sistemas operativos ni con navegadores remotos.

## Qué contiene el repositorio

El núcleo público está compuesto por:

- un CLI Playwright auditable;
- manifiestos versionados de capacidades;
- la skill `.agents/skills/arca-web-control/`;
- un MCP local `stdio` que reutiliza el mismo núcleo;
- pruebas, documentación y mecanismos de seguridad e idempotencia.

La skill está diseñada para Codex. Después de abrir la raíz del repositorio en Codex, invóquela explícitamente con `$arca-web-control` para que el agente cargue sus reglas operativas. La skill no es autónoma: depende del CLI versionado, las dependencias y los manifiestos de este repositorio. Otro agente puede adaptarla si sabe interpretar `SKILL.md` y ejecutar ese CLI local, pero esa compatibilidad no está garantizada.

Las personalizaciones de cada instalación no forman parte del proyecto público. Credenciales, emisores, perfiles de regímenes, jobs reales, sesiones, aprendizaje crudo, capturas, logs, ledger y PDFs deben permanecer en `%LOCALAPPDATA%\ManejoARCA` o en el Administrador de credenciales de Windows, nunca en Git.

## Principios de seguridad

- Las claves fiscales no se envían al chat, no se pasan como argumentos y no se imprimen.
- El CUIT identifica de forma única una credencial en el Administrador de credenciales de Windows.
- El navegador permanece visible para las primeras validaciones y para toda capacidad que no sea `fast_path`.
- `prepare-invoice` produce un resumen verificable y un `preparedInvoiceId` con vencimiento.
- Si una versión futura vuelve a habilitar emisión, solo la confirmación exacta `EMITIR` podrá autorizarla.
- El CLI valida el literal, pero no puede acreditar quién lo escribió: un agente nunca debe fabricarlo, inferirlo de una paráfrasis ni reutilizar una confirmación anterior.
- Un resultado incierto se registra como `unknown` y bloquea cualquier reintento automático.
- Captchas, selectores ambiguos, `403`, sesiones expiradas y pantallas inesperadas detienen el flujo.

## Instalación

Requisitos:

- Windows 10 u 11;
- Node.js 24;
- PowerShell;
- Chrome instalado o Chromium administrado por Playwright.

```powershell
npm ci
npx playwright install chromium
```

Ejecute luego las validaciones locales:

```powershell
npm test
npm run typecheck
npm audit --audit-level=high
npm run arca:capability:check
npm run validate:skill
npm run validate:public
npm run mcp:smoke
```

## Credenciales

El único proveedor operativo admitido es el Administrador de credenciales de Windows. El alta es interactiva: solicita el CUIT y después la clave sin mostrarla.

```powershell
npm run arca:credentials:set -- "EMISOR DE PRUEBA"
npm run arca:credentials:list
```

Para actualizar o eliminar una credencial, use su CUIT canónico y las confirmaciones exigidas por el CLI:

```powershell
npm run arca:credentials:update -- <CUIT_EMISOR> ACTUALIZAR_CREDENCIAL
npm run arca:credentials:delete -- <CUIT_EMISOR> ELIMINAR_CREDENCIAL
```

No copie credenciales, archivos CSV de clientes ni valores reales a un issue, pull request, fixture o conversación con un agente.

`.env.local` no puede usarse durante una sesión. Existe únicamente como vía transitoria para `arca:credentials:migrate-env`; después de migrar y comprobar el acceso, debe eliminarse. Consulte [Seguridad y credenciales](docs/seguridad-y-credenciales.md).

## Preparar una Factura C de servicios

Parta de [jobs/factura.example.json](jobs/factura.example.json) y guarde el job real exclusivamente en `%LOCALAPPDATA%\ManejoARCA\jobs\private`. La sesión y el MCP rechazan cualquier otra ubicación, enlaces y archivos no JSON. El contrato vigente exige `schemaVersion: 2`, `currency: "ARS"`, un `operationId` único, el CUIT canónico del emisor, la condición frente al IVA del receptor, fechas ISO, CUIT válidos y el importe como cadena decimal de dos dígitos. La moneda no se infiere: si falta `currency` o tiene otro valor, el job se rechaza antes de navegar.

```powershell
npm run arca:session:start -- --issuer <CUIT_EMISOR>
npm run arca:session:cmd -- prepare-invoice "<RUTA_PRIVADA_JOB_V2>"
```

El comando devuelve un `preparedInvoiceId`. Revise en el navegador el emisor, receptor, punto de venta, fechas, moneda local, condición de IVA, condición de venta, descripción y total. La preparación se detiene si `Moneda Extranjera` está marcada, falta o aparece de forma ambigua.

La versión pública actual se detiene aquí. No ejecute `emit-prepared-invoice`: el manifiesto lo rechaza hasta completar una nueva validación visible de la descarga automática del PDF y una promoción humana explícita. Cuando se vuelva a habilitar, conservará la confirmación exacta `EMITIR`; ninguna paráfrasis será válida.

Finalice la sesión de forma controlada:

```powershell
npm run arca:session:stop
```

## Aprendizaje visible

El modo de aprendizaje permite observar una operación nueva con Chrome visible:

```powershell
npm run arca:learn:start -- --issuer <CUIT_EMISOR> --capability <slug> --intent "<objetivo>"
npm run arca:learn:cmd -- note "<explicación sin datos personales>"
npm run arca:learn:cmd -- checkpoint "<etiqueta genérica sin datos reales>"
npm run arca:learn:cmd -- finish
npm run arca:learn:cmd -- abort
```

El aprendizaje crudo es privado. Los textos de `note` y los nombres de `checkpoint` se guardan literalmente y no se anonimizan automáticamente: no introduzca allí datos reales ni secretos. No debe publicarse HTML, screenshots, PDFs, traces, logs ni eventos obtenidos de una sesión real. `finish` genera solamente un candidato local: no crea una capacidad productiva ni habilita acciones irreversibles. Use `abort` para cancelar de forma segura ante datos personales, una pantalla inesperada o un recorrido que no deba conservarse; la cancelación no genera candidato.

Una capacidad pública se incorpora transformando lo aprendido en código general, selectores exactos, fixtures totalmente ficticios, pruebas, recuperación, manifiesto y documentación. Consulte [CONTRIBUTING.md](CONTRIBUTING.md).

## Evolución de capacidades

Las madureces son:

1. `observed`;
2. `assisted`;
3. `automated_to_summary`;
4. `controlled_irreversible`;
5. `fast_path`.

Ninguna capacidad irreversible se promociona automáticamente. El primer recorrido real debe ser visible, supervisado y aprobado por una persona. Solo `fast_path`, con evidencia suficiente y `hiddenAllowed: true`, podría admitir modo oculto; hoy no existe ninguna capacidad con esa habilitación.

## Documentación

- [Estado y roadmap](docs/estado-y-roadmap.md)
- [Operación con Chrome](docs/operacion-chrome.md)
- [Protocolo de aprendizaje](docs/protocolo-aprendizaje-operativo.md)
- [Seguridad y credenciales](docs/seguridad-y-credenciales.md)
- [Arquitectura MCP](docs/arquitectura-mcp.md)
- [Contribuciones](CONTRIBUTING.md)
- [Política de seguridad](SECURITY.md)

## Comunidad

Las contribuciones para nuevas capacidades son bienvenidas si son reproducibles, seguras y están completamente sanitizadas. Lea [CONTRIBUTING.md](CONTRIBUTING.md) y el [Código de conducta](CODE_OF_CONDUCT.md) antes de abrir un issue o pull request.

## Licencia

El código se distribuye bajo la [licencia Apache 2.0](LICENSE).
