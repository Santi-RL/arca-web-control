# Runtime y privacidad

Esta skill está ligada al motor CLI de este repositorio; no funciona como una carpeta autónoma.

## Plataforma soportada

- Windows 10 u 11.
- Node.js 24 y npm 11.
- Chrome o Chromium administrado por Playwright.
- Ejecución desde la raíz del repositorio.

macOS y Linux no están soportados. Requieren proveedores de credenciales, permisos y ciclo de procesos específicos que todavía no existen.

## Credenciales

- Usar exclusivamente el Administrador de credenciales de Windows mediante `ManejoARCA/CUIT/<cuit>`.
- No aceptar claves por chat, argumentos, stdin del agente, MCP, issues, PR, logs ni capturas.
- Usar `.env.local` únicamente dentro del comando explícito de migración y retirarlo después.

## Datos privados

Perfiles, jobs reales, sesiones, aprendizaje, logs, ledger, capturas, PDFs y metadatos viven en `%LOCALAPPDATA%\ManejoARCA`. Cada job real debe ser un archivo `.json` regular bajo `jobs\private`; la sesión y el MCP rechazan cualquier otra ubicación o enlace. Para datos recibidos por chat, `arca:job:create` consume JSON por `stdin`, aplica la ACL privada y devuelve un handle opaco que `prepare-invoice` resuelve dentro de esa carpeta. La raíz no es configurable mediante `ARCA_RUNTIME_ROOT`, y `NODE_ENV=test` no se admite en comandos operativos. `outputDir` es opcional y solo define una base relativa dentro de `downloads`; si se omite usa `"."`. La estructura final se genera automáticamente como `Emisores\<CUIT formateado - nombre>\Comprobantes Emitidos\<AAAA>\<MM>`. Los artefactos crudos nunca se versionan. Una contribución solo puede incluir código, documentación y fixtures totalmente ficticios, creados desde cero y no derivados de datos reales.
