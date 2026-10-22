# Fechas y horas uniformes — #126

Capturas sintéticas de la interfaz React, sin cuentas ni hardware reales.
Chrome 148 en Linux; locale `en-US`, zona `America/New_York` y escala 1.
La marca de referencia es `2026-01-03T00:07:00Z`: localmente corresponde a
`02/01/2026 19:07`. El reloj del escenario avanza 65 segundos.

| Vista | Captura | Qué comprobar |
| --- | --- | --- |
| Panel, 1440×1000 | [panel-date.png](panel-date.png) | «Directos anteriores» muestra `02/01/2026 19:07`. |
| Prompter, 1024×600 | [prompter-clock.png](prompter-clock.png) | Reloj de 24 horas `19:08`. |
| Dock, 420×800 | [dock-duration.png](dock-duration.png) | La duración `1:05` permanece intacta; no es una hora del día. |

El resumen Markdown conserva su zona `Europe/Madrid`, cubierta por tests
unitarios de cambio de fecha y horario de verano; estas imágenes no lo muestran.
Las capturas no acreditan Windows, Meld ni un Prompter físico.
