# ARCA Web Control

Este repositorio contiene una skill y un motor CLI para operar la interfaz web de ARCA con Playwright y supervisión humana.

## Uso de la skill

- Para cualquier pedido relacionado con ARCA, leer primero `.agents/skills/arca-web-control/SKILL.md` y las referencias que esa skill indique.
- Ejecutar los comandos desde la raíz de este repositorio en Windows.
- Usar el CLI versionado como motor auditable; no sustituirlo por clics genéricos, URLs internas ni scripts temporales.
- La skill no requiere un agente, proveedor, plugin o herramienta de revisión específicos. Si la plataforma no descubre skills automáticamente, abrir `SKILL.md` y seguir sus instrucciones junto con el CLI.

## Límites operativos

- Mantener credenciales, jobs reales, sesiones, perfiles, aprendizaje, logs, ledger, capturas, PDFs y metadatos exclusivamente en `%LOCALAPPDATA%\ManejoARCA`, fuera de Git.
- Tratar el CUIT como identidad única y no resolver automáticamente nombres ambiguos o sugeridos.
- No imprimir ni registrar claves, cookies, tokens, storage o material de sesión.
- No resolver captchas; solicitar intervención humana y continuar únicamente sobre la misma sesión.
- Detenerse ante selectores ambiguos, pantallas inesperadas, `403`, sesión expirada o estado `unknown`.
- Respetar el alcance y los comandos declarados por el manifiesto de cada capacidad. Llegar al resumen no autoriza una acción irreversible.
- No emitir si el manifiesto vigente no incluye el comando de emisión. Si una versión futura lo habilita, exigir un mensaje humano nuevo exactamente igual a `EMITIR` después de mostrar el resumen.
