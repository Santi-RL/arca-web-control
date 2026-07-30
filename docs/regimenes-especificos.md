# Regímenes específicos y actividades asociadas

## Regla general

`Actividades Asociadas` queda sin selección en una factura ordinaria. Que ARCA muestre una actividad habilitada no significa que deba seleccionarse. Un job v2 puede conservar una `activity` explícita por compatibilidad. Cuando además declara `specificRegime`, la actividad debe coincidir con el perfil privado del CUIT emisor y la capacidad especial debe estar validada antes de operar.

Los perfiles viven en `%LOCALAPPDATA%\ManejoARCA\issuers\<cuit>.json`, separados de la clave fiscal. No contienen contraseñas, cookies ni tokens.

## Regímenes confirmados

| ID | Régimen | Comprobantes asociados | Fuente oficial |
|---|---|---|---|
| `meat-remit` | Remito Electrónico Cárnico | `995` | [ARCA: vinculación remito/factura](https://www.afip.gob.ar/actividadesAgropecuarias/sector-pecuario/vinculacion-remito-factura.asp) |
| `flour-remit` | Remito Electrónico Harinero | `993`, `994` | [ARCA: procedimiento de molinería](https://www.afip.gob.ar/actividadesAgropecuarias/molineria/procedimiento.asp) |
| `conditioned-tobacco-remit` | Remito Electrónico de Tabaco Acondicionado | `88` | [Manual WSFEv1 vigente de ARCA](https://www.arca.gob.ar/ws/documentacion/manuales/manual-desarrollador-ARCA-COMPG.pdf) |

Esta lista no debe considerarse inmutable ni exhaustiva. Antes de configurar un régimen, verificar que la fuente siga vigente y que el código de actividad corresponda exactamente al emisor.

## Administración

```powershell
npm run arca:issuer:profile -- show --issuer <cuit-o-nombre-unico>
npm run arca:issuer:profile -- set-regime --issuer <cuit-o-nombre-unico> --regime meat-remit --activity <codigo-seis-digitos>
npm run arca:issuer:profile -- remove-regime --issuer <cuit-o-nombre-unico> --regime meat-remit ELIMINAR_REGIMEN
```

El nombre solo funciona cuando resuelve una coincidencia única. El archivo siempre se identifica por CUIT.

## Alcance actual

El perfil protege la selección de actividad, pero la carga automatizada de remitos asociados `995`, `993`, `994` u `88` requiere una capacidad específica adicional. La capacidad `invoice-services-single-item` no debe usarse para esos comprobantes hasta aprender y validar el flujo correspondiente.
