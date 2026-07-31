# Job v2 de la capacidad pública

La única capacidad automatizada actual es `invoice-services-single-item`: Factura C, concepto Servicios, moneda local y un ítem, únicamente hasta el resumen. La emisión está deshabilitada por el manifiesto vigente.

Ejemplo sintético:

```json
{
  "schemaVersion": 2,
  "operationId": "factura-ejemplo-2030-001",
  "issuerKey": "20000000001",
  "recipientCuit": "20000000001",
  "recipientName": "RECEPTOR DE PRUEBA",
  "recipientVatCondition": "Consumidor Final",
  "voucherType": "Factura C",
  "pointOfSale": "00001",
  "date": "2030-06-15",
  "concept": "Servicios",
  "currency": "ARS",
  "billingPeriodFrom": "2030-06-01",
  "billingPeriodTo": "2030-06-30",
  "saleCondition": "Transferencia Bancaria",
  "description": "Servicio de prueba",
  "amount": "123456.78"
}
```

## Intake conversacional exacto

`arca:invoice:prepare-chat` y `arca:job:create` reciben este contrato cerrado por `stdin`; no enviar `schemaVersion`, `operationId`, `issuerKey`, tipo, concepto ni moneda porque el motor los fija:

```json
{
  "intentId": "00000000-0000-4000-8000-000000000001",
  "intentRevision": 1,
  "issuerSelector": "Emisor ficticio",
  "recipientCuit": "20-00000000-1",
  "recipientName": "RECEPTOR DE PRUEBA",
  "recipientVatCondition": "Consumidor Final",
  "pointOfSale": 1,
  "date": "15/06/2030",
  "billingPeriodFrom": "01/06/2030",
  "billingPeriodTo": "30/06/2030",
  "dueDate": "Default",
  "saleCondition": "Transferencia bancaria",
  "description": "Servicio de prueba",
  "amount": "123.456,78"
}
```

`intentId` es un UUID generado por la capa agente para la solicitud actual: no es un dato fiscal ni se muestra al usuario. Se conserva al reintentar o reconstruir esa misma solicitud y se renueva para una intención comercial nueva, aun si todos los datos coinciden. `intentRevision` comienza en `1` y solo se incrementa cuando el usuario corrige o completa el borrador antes del límite irreversible. `recipientCommercialAddress` es opcional. Si se omite, ARCA debe devolver exactamente un domicilio; con más de uno, el agente muestra las opciones y espera una elección humana, conserva `intentId` e incrementa `intentRevision` al reenviar la dirección elegida. El ledger solo acepta esa revisión desde `failed_before_emit` o una preparación huérfana; `unknown` y `emitted` siguen siendo terminales. `dueDate` puede omitirse o usar `Default`; en ambos casos se calcula cinco días corridos desde `date`. `amount` es el precio unitario del único ítem: cantidad `1`, precio unitario, subtotal y total deben coincidir después de la verificación de ARCA.

Reglas:

- Cuando el usuario proporciona los datos por chat, usar `npm run arca:invoice:prepare-chat` y enviar el JSON exclusivamente por `stdin`. El campo `issuerSelector` puede ser un nombre solo si resuelve exactamente una credencial; el comando fija `Factura C`, `Servicios`, `ARS` y deriva un `operationId` y un handle opacos de `intentId`. Reutilizar el mismo `intentId` mantiene la identidad aunque cambien defaults o campos opcionales y bloquea cualquier intento de eludir un ledger `unknown` o `emitted`; un UUID nuevo permite una factura legítimamente idéntica. `arca:job:create` ofrece el mismo intake como primitiva de diagnóstico.
- Guardar todo job real exclusivamente como archivo `.json` regular dentro de `%LOCALAPPDATA%\ManejoARCA\jobs\private`; la sesión y el MCP rechazan otras ubicaciones y enlaces.
- Usar un `operationId` estable y único; el intake conversacional lo deriva de una intención explícita y nunca recicla esa intención para otra factura.
- Mantener `amount` como decimal con dos dígitos. Si llega como número JSON, debe tener como máximo dos decimales y se rechaza en lugar de redondearse.
- Declarar obligatoriamente `currency: "ARS"`. La omisión y cualquier otra moneda se rechazan antes de navegar.
- Usar CUIT válidos de once dígitos y el CUIT canónico del emisor como `issuerKey`.
- Al validar el receptor contra ARCA, exigir un único CUIT visible y que sus once dígitos coincidan exactamente con `recipientCuit`; no extraer dígitos de texto arbitrario. Comparar la razón social conservando igual cantidad y orden de términos, normalizando mayúsculas, tildes y puntuación (`S.A.` equivale a `SA`). Si aparece una forma societaria, debe estar presente en ambos nombres y coincidir exactamente. Solo se admite una inserción, eliminación, sustitución o transposición de un carácter en un único término no numérico de al menos seis caracteres; bloquear omisiones, agregados, reordenamientos, formas societarias múltiples y cualquier otra diferencia.
- Si falta el vencimiento, Servicios aplica cinco días corridos desde `date`, la fecha del comprobante.
- Dejar actividad, referencia comercial y unidad de medida vacías salvo indicación expresa.
- Omitir `outputDir` para usar la base privada predeterminada. Por compatibilidad puede indicar `"."` o una subcarpeta relativa de `downloads`, pero solo cambia la base: la estructura final por emisor, año y mes siempre se genera automáticamente. Se rechazan rutas absolutas, UNC y segmentos `..`.
- Después de validar el PDF, número, CAE y hash, archivar `Nombre - FC-C - 00001-00000042.pdf` junto a un JSON privado de metadatos. Facturas, notas de crédito y notas de débito usan códigos cerrados `FC`, `NC` y `ND` más la letra del comprobante.
- Rechazar Facturas A/B, Productos, conceptos mixtos, múltiples ítems, cualquier moneda distinta de ARS, notas, recibos y lotes como variantes no aprendidas. En ARCA debe existir un único checkbox visible `Moneda Extranjera` y permanecer desmarcado.
