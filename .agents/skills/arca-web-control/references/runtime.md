# Runtime y privacidad

Esta skill está ligada al motor CLI de este repositorio; no funciona como una carpeta autónoma.

## Plataforma soportada

- Windows 10 u 11.
- Node.js 24 y npm 11.
- Chrome o Chromium administrado por Playwright.
- Ejecución desde la raíz del repositorio.

macOS y Linux no están soportados. Aunque el almacén JSON es portable, los permisos, Chrome persistente y el ciclo de procesos todavía son específicos de Windows.

## Credenciales

La ubicación y protección de las claves es una decisión del usuario. El motor admite Windows como proveedor predeterminado y un archivo JSON externo como alternativa optativa. Consultar `references/credentials.md`. Nunca imprimir o registrar una clave ni incorporarla a Git.

## Datos privados

Perfiles, jobs reales, sesiones, aprendizaje, logs, ledger, capturas, PDFs y metadatos viven en `%LOCALAPPDATA%\ManejoARCA`. Cada job real debe ser un archivo `.json` regular bajo `jobs\private`; la sesión y el MCP rechazan cualquier otra ubicación o enlace. Para datos recibidos por chat, `arca:invoice:prepare-chat` conserva internamente el handle opaco; `arca:job:create` queda como primitiva de bajo nivel. La raíz no es configurable mediante `ARCA_RUNTIME_ROOT`, y `NODE_ENV=test` no se admite en comandos operativos. `outputDir` es opcional y solo define una base relativa dentro de `downloads`; si se omite usa `"."`. La estructura final se genera automáticamente como `Emisores\<CUIT formateado - nombre>\Comprobantes Emitidos\<AAAA>\<MM>`. Los artefactos crudos nunca se versionan. Una contribución solo puede incluir código, documentación y fixtures totalmente ficticios, creados desde cero y no derivados de datos reales.

La atestación operativa protege solo `config`, `profiles`, `issuers`, `sessions`, `learning`, `ledger`, `jobs`, `private-import`, `guided`, `logs` y `downloads`; es constante respecto del volumen histórico. Un runtime existente sin el marcador `runtime-layout-v3` se bloquea hasta ejecutar una única reparación explícita. `arca:runtime:repair` preinspecciona y recorre únicamente esos subárboles, escribe el marcador y nunca visita carpetas desconocidas; después no vuelve a ejecutarse automáticamente. Cada archivo administrado debe tener una única identidad física: symlinks, junctions y hardlinks detienen la reparación antes de cambiar ACL. Una exclusión mutua del sistema operativo cubre toda la transición de reparación y el arranque hasta publicar el indicador de sesión o aprendizaje, por lo que ambos estados no pueden superponerse.
