# Contribuir a ARCA Web Control

Gracias por ayudar a construir una operación de ARCA más auditable y segura. Este proyecto acepta mejoras generales y nuevas capacidades; no acepta configuraciones particulares de contribuyentes ni evidencia fiscal real.

## Antes de participar

- Lea el [README](README.md), el [protocolo de aprendizaje](docs/protocolo-aprendizaje-operativo.md) y el registro de [capacidades](docs/capacidades.md).
- Use Windows 10 u 11 para reproducir flujos Playwright.
- Busque un issue existente antes de abrir uno nuevo.
- Para vulnerabilidades, siga [SECURITY.md](SECURITY.md) y no abra un reporte público con detalles explotables.

## Privacidad: regla de aceptación obligatoria

Un issue o pull request no puede contener:

- nombres de personas, contribuyentes o empresas reales;
- CUIT, CUIL, DNI, CAE, números de comprobante o puntos de venta reales;
- domicilios, correos electrónicos, teléfonos, importes o fechas derivados de una operación real;
- claves, tokens, cookies, storage, perfiles, certificados o datos del Administrador de credenciales;
- jobs reales, CSV o planillas de clientes;
- screenshots, PDFs, HTML, traces, HAR, logs o artefactos crudos obtenidos de ARCA;
- rutas locales que revelen el nombre del usuario o datos privados.

No alcanza con alterar parcialmente un dato real. Los fixtures deben diseñarse desde cero con identidades, importes, fechas, direcciones y comprobantes ficticios. Antes de enviar cambios, revise tanto archivos rastreados como no rastreados y el historial de la rama.

Si un dato sensible se incorpora accidentalmente, no continúe publicándolo ni lo copie a un comentario. Revoque la credencial cuando corresponda, avise por el canal privado de seguridad y limpie toda la historia afectada.

## Proponer una capacidad

Para una capacidad nueva o un cambio de alto riesgo, abra primero el formulario **Nueva capacidad**. Para una corrección pequeña y acotada puede enviar directamente un pull request. Describa, en el issue o en el pull request:

1. el objetivo general;
2. las pantallas y controles visibles, sin datos de una sesión real;
3. si existe alguna acción irreversible;
4. el esquema de entrada propuesto;
5. los desvíos esperables y su recuperación;
6. cómo se probará con DOM o sitio local simulado.

No adjunte evidencia cruda. Si la propuesta nació de `arca:learn`, conserve ese material exclusivamente en el almacenamiento privado local y traduzca el aprendizaje a una especificación genérica.

## Madurez de una capacidad

Toda capacidad avanza de forma explícita:

- `observed`: pantalla conocida, sin automatización confiable;
- `assisted`: recorrido visible y guiado;
- `automated_to_summary`: automatización reproducible hasta un resumen verificable;
- `controlled_irreversible`: acción final protegida por confirmación humana y evidencia;
- `fast_path`: flujo repetido, recuperable y apto para mínima intervención.

Una acción irreversible nunca se promociona automáticamente. Requiere una primera corrida visible, aprobación humana y la confirmación exacta definida por el manifiesto. Para emisión de comprobantes, esa confirmación es `EMITIR`.

## Flujo de desarrollo

Antes de crear commits, configure en este repositorio el correo `noreply` exacto que GitHub muestra para su cuenta en **Settings > Emails**. No lo adivine ni use un correo personal:

```powershell
git config --local user.email "<CORREO_NOREPLY_MOSTRADO_POR_GITHUB>"
```

`validate:public` revisa archivos, nombres de archivo, mensajes e identidades de todo el historial alcanzable. Un commit con correo personal o datos sensibles hará fallar el gate aunque el archivo ya se haya borrado en `HEAD`.

1. Cree una rama acotada al cambio; vincule un issue cuando exista.
2. Implemente el flujo en el núcleo Playwright, sin comandos genéricos de clic o relleno para producción.
3. Use selectores exactos y únicos por `id`, `name`, rol o contexto.
4. Agregue fixtures DOM sanitizados y pruebas de éxito, ambigüedad, campos faltantes, expiración y recuperación.
5. Cree o actualice el manifiesto de capacidad.
6. Documente límites, acción irreversible, confirmación, evidencia y recuperación.
7. Sincronice la documentación generada y las referencias de la skill.
8. Ejecute todos los controles locales.

Comandos mínimos:

```powershell
npm test
npm run typecheck
npm audit --audit-level=high
npm run arca:capability:sync
npm run arca:capability:check
npm run validate:skill
npm run validate:public
npm run mcp:smoke
```

Los cambios no triviales también deben pasar revisión de seguridad y revisión de código antes de solicitar promoción.

## Requisitos de un pull request

Un pull request debe:

- vincular el issue correspondiente o indicar expresamente que no aplica para un cambio pequeño;
- declarar alcance y fuera de alcance;
- indicar la madurez anterior y la propuesta;
- describir expresamente cualquier acción irreversible;
- incluir pruebas reproducibles sin conectarse a ARCA;
- incluir recuperación ante cambios de pantalla, errores y estado incierto;
- mantener `hiddenAllowed: false` salvo una decisión humana documentada y todos los requisitos de `fast_path`;
- actualizar manifiesto, documentación y referencias generadas cuando corresponda;
- confirmar que no contiene PII, secretos ni artefactos reales;
- evitar cambios no relacionados.

Los mantenedores pueden pedir que una capacidad permanezca en una madurez menor aunque el flujo funcione técnicamente.

## Primera validación visible

Las pruebas automatizadas no reemplazan una validación humana contra la interfaz vigente. La primera ejecución real de una capacidad nueva debe:

- realizarse con Chrome visible;
- detenerse ante captcha, selector ambiguo o pantalla inesperada;
- llegar primero a un resumen completo;
- obtener aprobación humana antes de cualquier acción irreversible;
- registrar en la documentación pública solamente el resultado técnico sanitizado;
- conservar toda evidencia fiscal exclusivamente fuera de Git.

## Estilo y documentación

- Escriba documentación de usuario en español profesional, con tildes, `ñ` y signos de apertura.
- Prefiera cambios pequeños y revisables.
- Explique el motivo de las decisiones de seguridad y recuperación.
- No convierta conocimiento de una sesión en instrucciones manuales permanentes: incorpórelo al código, pruebas, manifiesto y documentación.

Al participar, acepta el [Código de conducta](CODE_OF_CONDUCT.md) y que su contribución se distribuya bajo la [licencia Apache 2.0](LICENSE).
