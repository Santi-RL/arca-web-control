# Comandos versionados

Archivo generado desde el registro de comandos del proyecto. No editar manualmente.

- `npm run arca:credentials:set`: Alta interactiva por CUIT único en el Administrador de credenciales de Windows.
- `npm run arca:credentials:list`: Lista contribuyentes por CUIT y nombre sin mostrar claves.
- `npm run arca:credentials:update`: Actualiza por CUIT con confirmación ACTUALIZAR_CREDENCIAL.
- `npm run arca:credentials:delete`: Elimina por CUIT con confirmación ELIMINAR_CREDENCIAL.
- `npm run arca:credentials:migrate-env`: Migra temporalmente desde .env.local.
- `npm run arca:credentials:migrate-vault`: Migra explícitamente credenciales legacy al esquema canónico por CUIT.
- `npm run arca:credentials:import-csv`: Importa localmente un CSV privado con simulación, CUIT único y rollback.
- `npm run arca:credentials:provider`: Consulta o selecciona Windows o un archivo JSON externo administrado por el usuario.
- `npm run arca:issuer:resolve`: Resuelve rápidamente un emisor sobre el índice no secreto y propone candidatos sin cargar claves.
- `npm run arca:invoice:prepare-chat`: Valida datos conversacionales, crea o reutiliza el job privado idempotente, inicia o reutiliza Chrome visible y devuelve el resumen.
- `npm run arca:session:start`: Inicia una sesión y exige READY_STATE=portal; la revalidación irreversible requiere un modo visible explícito y exclusivo.
- `npm run arca:session:cmd`: Ejecuta comandos tipados sobre la sesión actual; emit-prepared-invoice exige preparedInvoiceId vigente y EMITIR, y revalidate-prepared-invoice queda reservado a validación controlada.
- `npm run arca:session:stop`: Cierra la sesión de forma controlada.
- `npm run arca:learn:start`: Inicia aprendizaje visible; ante captcha conserva Chrome y publica el estado pausado.
- `npm run arca:learn:cmd`: Reanuda explícitamente una pausa de autenticación, inspecciona y controla de forma híbrida la sesión visible, agrega evidencia o finaliza el candidato.
- `npm run arca:job:migrate`: Migra jobs v1 a schemaVersion 2.
- `npm run arca:job:create`: Crea o reutiliza un job v2 idempotente desde JSON recibido por stdin y devuelve un identificador opaco.
- `npm run arca:runtime:repair`: Migra o repara explícitamente las ACL administradas y escribe el marcador de layout; nunca se ejecuta en el hot path.
- `npm run arca:capability:sync`: Regenera documentación y referencias de la skill.
- `npm run arca:capability:check`: Verifica manifiestos, evidencia y sincronización.
- `npm run arca:capability:promote`: Promueve madurez con aprobación humana explícita.
- `npm run arca:mcp`: Inicia el MCP local stdio.
- `npm run arca:issuer:profile`: Consulta o configura regímenes específicos por CUIT sin mezclar datos con la credencial.
- `npm run arca:invoice:recover-pdf`: Recupera un PDF, valida número/CAE/hash, publica PDF y metadatos en el archivo canónico y reconcilia un ledger unknown.

La emisión habilitada se ejecuta con `npm run arca:session:cmd -- emit-prepared-invoice <preparedInvoiceId> EMITIR`.
