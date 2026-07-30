# Seguridad y credenciales

## Ubicación

- Credenciales: proveedor elegido por el usuario. Windows usa el recurso `ManejoARCA/CUIT/<cuit>`; `json-file` lee un archivo externo administrado por el usuario.
- Identidad única: CUIT válido de once dígitos. El nombre descriptivo no es único y puede repetirse.
- Runtime privado: `%LOCALAPPDATA%\ManejoARCA`.
- Código y ejemplos completamente ficticios, creados desde cero: repositorio Git.

El runtime aplica ACL sin herencia en sus límites administrados y concede control únicamente al usuario actual y `SYSTEM`. No sincronizarlo con servicios en la nube. El archivo de un proveedor externo conserva los permisos decididos por el usuario y no es modificado por el proyecto.

La raíz operativa es fija: `%LOCALAPPDATA%\ManejoARCA`. `ARCA_RUNTIME_ROOT` no es una opción admitida y `NODE_ENV=test` hace que los comandos operativos se detengan; las pruebas automatizadas usan inyección explícita y no pueden desactivar ACL mediante variables heredadas. `outputDir` es opcional y solo puede indicar una base relativa de `downloads`; la estructura final por emisor se genera automáticamente.

## Selección del proveedor

Sin configuración se usa Windows. Para seleccionar un JSON externo regular, fuera del repositorio y de hasta 1 MiB:

```powershell
npm run arca:credentials:provider -- set json-file "D:\Datos privados\credenciales-arca.json"
npm run arca:credentials:provider -- show
npm run arca:credentials:provider -- set windows
```

El formato y las reglas están documentados en la referencia de credenciales de la skill. La configuración local guarda el tipo de proveedor, la ruta, un índice no secreto de CUIT/nombre y la identidad técnica del archivo, nunca la clave. Si el archivo cambia debe seleccionarse otra vez. El launcher y el worker verifican la huella antes y después de cargar la credencial para cancelar cualquier cambio durante el arranque.

## Alta, actualización y resolución en Windows

- `arca:credentials:set -- "<nombre>"` valida el CUIT y rechaza duplicados antes de solicitar la clave.
- `arca:credentials:update -- <cuit> ACTUALIZAR_CREDENCIAL` es la única ruta para reemplazar nombre o clave de un CUIT existente.
- `arca:credentials:delete -- <cuit> ELIMINAR_CREDENCIAL` elimina la identidad fiscal completa.
- Los comandos operativos deben usar CUIT. Un nombre se admite únicamente si coincide con una sola credencial; dos personas llamadas igual producen un error de ambigüedad.
- Nunca inferir que dos nombres iguales son la misma persona ni crear dos registros para el mismo CUIT.

## Rechazo de credenciales durante el login

- Si ARCA muestra `Clave o usuario incorrecto`, el proceso debe informar `ARCA_INVALID_CREDENTIALS`, cerrar el contexto del navegador y finalizar sin reintentar.
- No tratar este mensaje como captcha, demora de navegación ni pantalla inesperada. Tampoco volver a enviar automáticamente el CUIT o la clave: los intentos adicionales pueden bloquear el acceso fiscal.
- Antes de iniciar otra sesión para ese CUIT, corregirla en el proveedor elegido. Para Windows:

  ```powershell
  npm run arca:credentials:update -- <cuit> ACTUALIZAR_CREDENCIAL
  ```

- No repetir la clave en respuestas, argumentos, logs ni capturas. Después de actualizarla, iniciar una sesión nueva; nunca reutilizar el intento rechazado.

## Migración del almacén legacy

Ejecutar primero `arca:credentials:list`. Luego:

```powershell
npm run arca:credentials:migrate-vault -- --dry-run
npm run arca:credentials:migrate-vault -- --write MIGRAR_CREDENCIALES
```

La migración copia cada secreto directamente dentro del PasswordVault, crea el recurso canónico y elimina el registro legacy solo después de guardar el nuevo. Los CUIT inválidos o conflictivos quedan sin modificar y se informan para resolución manual.

## Migración desde `.env.local`

`.env.local` no es un proveedor operativo. Las sesiones, el login y la emisión nunca lo cargan; solo `arca:credentials:migrate-env` puede leerlo de forma explícita.

1. Copiar `.env.local.example` a `.env.local`, restringir sus permisos y completar únicamente las variables temporales de migración.
2. Ejecutar la migración para cada etiqueta incluida en el archivo:

   ```powershell
   npm run arca:credentials:migrate-env -- "EMISOR_EJEMPLO"
   ```

3. Si la terminal conserva la variable legacy `ARCA_CREDENTIAL_PROVIDER`, eliminarla con `Remove-Item Env:ARCA_CREDENTIAL_PROVIDER` o abrir una terminal nueva.
4. Probar el login visible usando Windows PasswordVault.
5. Eliminar `.env.local` después de validar todos los emisores.

No pasar claves por argumentos, MCP, logs o capturas de pantalla. Para una selección temporal del proceso actual en PowerShell:

```powershell
$env:ARCA_CREDENTIAL_PROVIDER = "json-file"
$env:ARCA_CREDENTIAL_FILE = "D:\Datos privados\credenciales-arca.json"
npm run arca:invoice:prepare-chat
Remove-Item Env:ARCA_CREDENTIAL_PROVIDER -ErrorAction SilentlyContinue
Remove-Item Env:ARCA_CREDENTIAL_FILE -ErrorAction SilentlyContinue
```

Las variables prevalecen sobre `arca:credentials:provider -- set`, contienen configuración y nunca el secreto. `json-file` exige la ruta y, en esta modalidad temporal sin índice, el emisor se indica por CUIT; `windows` es explícito e ignora una ruta residual. Para volver a la selección persistente se quitan ambas variables. El proveedor `.env.local` continúa bloqueado.

## Importación inicial desde CSV

El CSV debe estar codificado como UTF-8 y contener exactamente estas columnas, en este orden:

```text
Contribuyente,CUIT,Clave ARCA
```

1. Cerrar Excel y mover el archivo a `%LOCALAPPDATA%\ManejoARCA\private-import`. Esta carpeta no debe sincronizarse con OneDrive, Google Drive ni otro servicio.
2. Ejecutar la simulación. El comando solicitará la ruta en la terminal local; no escribirla en el chat ni pasarla como argumento:

   ```powershell
   npm run arca:credentials:import-csv -- --dry-run
   ```

3. Verificar únicamente los totales informados. CUIT repetidos dentro del CSV, columnas incorrectas, claves vacías o CUIT inválidos bloquean el lote completo.
   Durante la simulación debe informarse `SOURCE_DELETE_REQUIRED=0`; el archivo todavía es necesario para ejecutar la escritura.
4. Ejecutar la escritura explícita:

   ```powershell
   npm run arca:credentials:import-csv -- --write IMPORTAR_CREDENCIALES
   ```

5. Los CUIT que ya existen se omiten y nunca se actualizan silenciosamente. Para reemplazar una clave existente se usa `arca:credentials:update`.
6. Verificar los totales y eliminar el CSV de origen. La eliminación normal no garantiza borrado físico en SSD, copias de seguridad o servicios sincronizados; si el archivo estuvo sincronizado, eliminar también sus versiones remotas y considerar rotar las claves.
   Solo una escritura finalizada correctamente informa `SOURCE_DELETE_REQUIRED=1`.

El importador restringe la ACL del archivo al usuario actual y `SYSTEM`, no imprime filas ni secretos, valida el lote completo antes de escribir y revierte todas las altas nuevas si una escritura falla. El archivo continúa siendo texto plano hasta que se elimina: el Administrador de credenciales protege las claves almacenadas, no el CSV de origen.

## Datos operativos

Los jobs reales, perfiles, capturas, PDFs, metadatos JSON, logs, tokens locales de sesión, candidatos de aprendizaje y ledger son privados. Solo pueden incorporarse a Git código general, documentación sanitizada y fixtures completamente ficticios que no deriven de una operación real.

Los datos de una factura recibidos por chat deben pasar por `arca:invoice:prepare-chat`. El comando lee JSON por `stdin`, no admite campos fuera del alcance vigente, resuelve el nombre solo si es unívoco, crea el job de forma exclusiva y conserva su identificador internamente. `arca:job:create` mantiene el mismo intake como herramienta de bajo nivel.

Ante un artefacto sensible dentro del repositorio: detener la operación, moverlo al runtime privado, revisar el historial Git antes de publicar y rotar la credencial si existe riesgo de exposición.
