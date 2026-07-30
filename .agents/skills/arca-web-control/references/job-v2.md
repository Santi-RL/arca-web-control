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

Reglas:

- Cuando el usuario proporciona los datos por chat, crear el archivo mediante `npm run arca:job:create`, enviando el JSON exclusivamente por `stdin`. El campo de entrada `issuerSelector` puede ser un nombre solo si resuelve exactamente una credencial; el comando fija `Factura C`, `Servicios`, `ARS`, genera un `operationId` aleatorio y devuelve un `JOB_HANDLE` sin nombres ni CUIT.
- Guardar todo job real exclusivamente como archivo `.json` regular dentro de `%LOCALAPPDATA%\ManejoARCA\jobs\private`; la sesión y el MCP rechazan otras ubicaciones y enlaces.
- Usar un `operationId` estable y único; nunca reciclarlo para otra factura.
- Mantener `amount` como decimal con dos dígitos.
- Declarar obligatoriamente `currency: "ARS"`. La omisión y cualquier otra moneda se rechazan antes de navegar.
- Usar CUIT válidos de once dígitos y el CUIT canónico del emisor como `issuerKey`.
- Si falta el vencimiento, Servicios aplica cinco días corridos desde la emisión.
- Dejar actividad, referencia comercial y unidad de medida vacías salvo indicación expresa.
- Omitir `outputDir` para usar la base privada predeterminada. Por compatibilidad puede indicar `"."` o una subcarpeta relativa de `downloads`, pero solo cambia la base: la estructura final por emisor, año y mes siempre se genera automáticamente. Se rechazan rutas absolutas, UNC y segmentos `..`.
- Después de validar el PDF, número, CAE y hash, archivar `Nombre - FC-C - 00001-00000042.pdf` junto a un JSON privado de metadatos. Facturas, notas de crédito y notas de débito usan códigos cerrados `FC`, `NC` y `ND` más la letra del comprobante.
- Rechazar Facturas A/B, Productos, conceptos mixtos, múltiples ítems, cualquier moneda distinta de ARS, notas, recibos y lotes como variantes no aprendidas. En ARCA debe existir un único checkbox visible `Moneda Extranjera` y permanecer desmarcado.
