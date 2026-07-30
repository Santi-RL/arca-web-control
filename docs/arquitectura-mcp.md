# MCP local ARCA

El servidor `npm run arca:mcp` usa transporte `stdio` y delega en el mismo CLI/sesión Playwright. No implementa lógica fiscal duplicada.

Herramientas actuales:

- Sesión: `arca_session_start`, `arca_session_status`, `arca_session_stop`.
- Aprendizaje: `arca_learn_start`, `arca_learn_note`, `arca_learn_checkpoint`, `arca_learn_finish`.
- Facturación: `arca_prepare_invoice`; `arca_emit_prepared_invoice` y `arca_download_pdf` son contratos reservados para una futura promoción y el manifiesto vigente los bloquea siempre.

No acepta claves, cookies, tokens ni herramientas genéricas de clic o relleno. La emisión está deshabilitada actualmente; si se promociona otra vez, exigirá UUID de preparación y `confirmation: "EMITIR"`.

`arca_query_issued_invoices` se incorporará únicamente cuando la consulta tenga comando reproducible, fixtures, evidencia visible y manifiesto promocionado.
