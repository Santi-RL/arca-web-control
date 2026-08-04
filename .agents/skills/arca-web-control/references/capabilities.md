# Referencia de capacidades

Archivo generado. Consultar el manifiesto canónico antes de operar.

## Factura C de servicios de un ítem

- ID: `invoice-services-single-item`
- Madurez: `controlled_irreversible`
- Modo oculto: prohibido
- Alcance runtime: `Factura C` / `Servicios` / `ARS` / 1 ítem / receptor `identified-cuit`
- Comandos: `status`, `snapshot`, `screenshot`, `prepare-invoice`, `emit-prepared-invoice`
- Acción irreversible: Emitir el comprobante en ARCA
- Confirmación: `EMITIR`
- Validación visible: 2026-08-03
- Recuperación: Detenerse y capturar evidencia. Ante 403 o sesión expirada, no reenviar el formulario: autenticar nuevamente y reconstruir el borrador. Ante estado unknown, consultar ARCA antes de cualquier reintento y reconciliar el PDF en el archivo canónico privado.

## Factura C de servicios de un ítem para consumidor final anónimo

- ID: `invoice-services-single-item-consumidor-final-anonimo`
- Madurez: `controlled_irreversible`
- Modo oculto: prohibido
- Alcance runtime: `Factura C` / `Servicios` / `ARS` / 1 ítem / receptor `anonymous-final-consumer`
- Comandos: `status`, `snapshot`, `screenshot`, `prepare-invoice`, `emit-prepared-invoice`
- Acción irreversible: Emitir el comprobante en ARCA
- Confirmación: `EMITIR`
- Validación visible: 2026-08-01
- Recuperación: Detenerse y capturar evidencia. Ante 403 o sesión expirada, no reenviar el formulario: autenticar nuevamente y reconstruir el borrador. Ante estado unknown, consultar ARCA antes de cualquier reintento y reconciliar el PDF en el archivo canónico privado.
