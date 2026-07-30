# Proveedores de credenciales

El usuario decide dónde almacenar las claves y asume la protección del medio elegido. La skill no condiciona la operación al Administrador de credenciales de Windows.

## Windows, opción predeterminada

Sin configuración adicional se usa `ManejoARCA/CUIT/<cuit>` en el Administrador de credenciales. Los comandos `arca:credentials:set`, `list`, `update`, `delete` y `migrate-*` administran exclusivamente este proveedor.

## Archivo JSON elegido por el usuario

El archivo debe estar fuera del repositorio, ser regular, no ser un enlace o junction y medir como máximo 1 MiB. ARCA Web Control lo abre solo para lectura y no modifica sus permisos. El usuario puede crearlo con la herramienta local que prefiera y comunicar al agente únicamente su ruta; no hace falta incorporarlo al proyecto. Formato:

```json
{
  "schemaVersion": 1,
  "credentials": [
    {
      "cuit": "20000000001",
      "displayName": "Emisor ficticio",
      "clave": "valor administrado por el usuario"
    }
  ]
}
```

Activar o consultar el proveedor:

```powershell
npm run arca:credentials:provider -- set json-file "D:\Datos privados\credenciales-arca.json"
npm run arca:credentials:provider -- set windows
npm run arca:credentials:provider -- show
```

Al seleccionarlo se guarda en el runtime privado un índice no secreto de CUIT y nombre, junto con la identidad técnica del archivo. Así, resolver un nombre no carga claves en el proceso coordinador. Si el archivo cambia —por ejemplo, al actualizar una clave— hay que ejecutar nuevamente `set json-file` antes del próximo login.

También puede hacerse una selección temporal para el proceso actual. En PowerShell:

```powershell
$env:ARCA_CREDENTIAL_PROVIDER = "json-file"
$env:ARCA_CREDENTIAL_FILE = "D:\Datos privados\credenciales-arca.json"
npm run arca:invoice:prepare-chat
Remove-Item Env:ARCA_CREDENTIAL_PROVIDER -ErrorAction SilentlyContinue
Remove-Item Env:ARCA_CREDENTIAL_FILE -ErrorAction SilentlyContinue
```

Las variables de entorno prevalecen sobre `arca:credentials:provider -- set`. `ARCA_CREDENTIAL_PROVIDER=json-file` exige `ARCA_CREDENTIAL_FILE` y, como no crea un índice persistente, el emisor debe indicarse por CUIT. `ARCA_CREDENTIAL_PROVIDER=windows` selecciona Windows aunque quede una ruta residual. Para volver a la configuración persistente hay que quitar ambas variables. No usar variables que contengan la clave.

## Invariantes

- CUIT válido y único; el nombre solo resuelve si corresponde a un único CUIT.
- La resolución rutinaria por nombre usa el índice local no secreto; la clave se carga únicamente dentro del proceso de sesión y no viaja por argumentos, MCP, estado, logs ni archivos fiscales.
- El launcher fija una huella no reversible del proveedor; si la configuración cambia antes de cargar la clave, cancela el inicio.
- Una clave incorrecta produce un único intento de login y detención inmediata.
- Los errores públicos distinguen ausencia, ambigüedad y proveedor no disponible sin revelar registros ni secretos.
