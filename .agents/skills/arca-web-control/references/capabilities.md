# Referencia de capacidades

Archivo generado. Consultar el manifiesto canónico antes de operar.

## Factura C de servicios de un ítem

- ID: `invoice-services-single-item`
- Madurez: `automated_to_summary`
- Modo oculto: prohibido
- Alcance runtime: `Factura C` / `Servicios` / `ARS` / 1 ítem
- Comandos: `status`, `snapshot`, `screenshot`, `prepare-invoice`
- Acción irreversible: Emitir el comprobante en ARCA
- Confirmación: `EMITIR`
- Validación visible: Versión actual: pendiente de revalidación visible
- Recuperación: Detenerse y capturar evidencia. Ante 403 o sesión expirada, no reenviar el formulario: autenticar nuevamente y reconstruir el borrador. Ante estado unknown, consultar ARCA antes de cualquier reintento y reconciliar el PDF en el archivo canónico privado.
