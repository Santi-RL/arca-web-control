# Política de seguridad

ARCA Web Control automatiza una interfaz fiscal y maneja información especialmente sensible. La seguridad, la privacidad y la prevención de acciones duplicadas forman parte del comportamiento funcional del proyecto.

## Estado de soporte

El proyecto es experimental y todavía no publica versiones estables. Solo se evalúan correcciones sobre la rama principal vigente. No se garantiza soporte de ramas antiguas ni un plazo de respuesta.

## Reportar una vulnerabilidad

Use el reporte privado de vulnerabilidades de GitHub en la pestaña **Security** del repositorio. No abra un issue público para informar:

- credenciales o secretos expuestos;
- bypass de la confirmación `EMITIR`;
- posibilidad de duplicar una operación fiscal;
- acceso a perfiles, sesiones, cookies, storage o datos privados;
- escapes de `%LOCALAPPDATA%\ManejoARCA` o fallas de ACL;
- escritura fuera de destinos privados;
- exposición de PII en aprendizaje, logs, errores, MCP o documentación;
- una forma de automatizar captchas o eludir controles de ARCA.

Si el reporte privado no estuviera habilitado, abra únicamente un issue solicitando un canal privado, sin incluir detalles técnicos, datos personales, URLs de sesión, capturas ni pruebas de concepto.

Incluya en el reporte privado, cuando sea seguro:

- versión o commit afectado;
- impacto y escenario de amenaza;
- pasos mínimos con datos completamente ficticios;
- comportamiento esperado;
- mitigación sugerida;
- confirmación de que no se ejecutó una acción fiscal real para demostrar el problema.

## Datos que nunca deben enviarse

No adjunte claves fiscales, CUIT reales, cookies, tokens, perfiles, certificados, jobs, CSV, planillas, PDFs, screenshots, HTML, traces, HAR, logs ni contenido copiado de una sesión de ARCA. Una ruta o un mensaje de error también puede contener PII o identificadores de sesión: redáctelo antes de informar.

## Credencial o dato publicado accidentalmente

Eliminar el archivo en un commit posterior no borra la historia. Ante una exposición:

1. detenga la publicación o distribución;
2. revoque o cambie inmediatamente la credencial afectada;
3. informe por el canal privado;
4. elimine el dato de todas las referencias e historia Git;
5. vuelva a verificar clones, forks, artefactos y caches;
6. ejecute un escaneo de secretos antes de reabrir la rama.

No reutilice una clave que haya sido publicada, aunque el repositorio haya sido privado o el commit se haya borrado.

## Alcance de la investigación

No realice pruebas que:

- emitan, modifiquen, presenten, paguen o envíen datos fiscales reales;
- intenten bloquear cuentas mediante logins repetidos;
- extraigan información de otros contribuyentes;
- interfieran con ARCA o degraden sus servicios;
- evadan captchas, autenticación o controles de acceso.

Use fixtures locales y sitios simulados. La autorización para investigar este repositorio no concede autorización sobre los sistemas de ARCA.

## Divulgación coordinada

Los mantenedores intentarán confirmar el reporte, evaluar el impacto y coordinar una corrección antes de divulgar detalles. Al tratarse de un proyecto experimental y voluntario, no se ofrece un SLA ni recompensa económica.
