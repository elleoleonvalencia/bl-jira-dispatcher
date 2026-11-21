# bl-jira-dispatcher

Lanza los agentes de IA (rutinas de Claude Code) cuando un ticket de Jira entra en un estado con agente. Sirve para varios proyectos (KAN = BL Nutrition, BLFIT = BL Fitt, BLWEB = BL Web), cada uno con su interruptor en `projects.json`. Sustituye a las reglas de Jira Automation, que en el plan gratuito de Jira se quedan sin pasos.

## Cómo funciona

Cada 5 minutos, lanzado desde cron-job.org con `workflow_dispatch` (`.github/workflows/dispatch.yml`). El `schedule` de GitHub queda solo de respaldo: en la práctica GitHub lo ejecuta cada varias horas.

1. Busca en Jira los tickets actualizados en las últimas 24 horas que están en un estado con agente.
2. Mira el **último cambio de estado** de cada uno. Si es nuevo (no está en `state.json`) y el ticket sigue en ese estado, llama a la rutina de Claude del agente. Un ticket que sigue parado en un estado no vuelve a disparar.
3. Si la rutina no responde bien tras dos intentos, comenta `[IA:ERROR]` en el ticket.
4. Guarda en `state.json` los cambios ya disparados (se limpian a los 3 días).

| Estado | Agente |
|---|---|
| Entrada rápida | Agente rápido |
| Analizando | Analizador |
| Planificando | Planificador |
| Implementando, Correcciones de código | Implementador |
| Revisando código | Revisor |

Para relanzar un agente: saca el ticket del estado y vuelve a meterlo.

Los tickets con la etiqueta `relevo-claude` se ignoran (si lleva más de 6 h puesta se da por abandonada, por si el relevo se cortó): los está trabajando el supervisor nocturno porque Cursor se quedó sin saldo. Cuando la quita, si el ticket quedó en un estado con agente, se dispara en la siguiente pasada.

## Proyectos (`projects.json`)

```json
"BLFIT": { "name": "BL Fitt", "enabled": false, "since": null }
```

- `enabled`: interruptor. Un proyecto apagado ni se consulta.
- `since`: hora desde la que se disparan sus cambios. **Al encender un proyecto, pon aquí la hora de encendido** (UTC, ISO 8601): así no se disparan de golpe los cambios de estado anteriores. Sin `since` no dispara nada.
- Rutinas: por defecto todos los proyectos usan las mismas rutinas de Claude (`CLAUDE_<AGENTE>_URL`); el agente sabe de qué proyecto es el ticket por su clave. Si un proyecto necesita automatizaciones propias, crea los secretos `CURSOR_<PROYECTO>_<AGENTE>_URL` y `_TOKEN` y añádelos al `env` de `dispatch.yml`: tienen preferencia.

## Rutinas de Claude Code

Si existe el secreto `CLAUDE_<AGENTE>_URL` (la URL `.../routines/<trigger>/fire` de la rutina) con su
`CLAUDE_<AGENTE>_TOKEN`, el disparador llama a esa rutina con un texto como
«Ticket KAN-7 (proyecto KAN) en estado «Analizando». Agente: analizador.». También admite
`CLAUDE_<PROYECTO>_<AGENTE>_URL`. Sin rutina configurada, comenta `[IA:ERROR]` en el ticket. Instrucciones de las rutinas:
`claude/rutina-agente.md` en bl-agentes.

## Secretos (Settings → Secrets and variables → Actions)

| Secreto | Qué es |
|---|---|
| `JIRA_EMAIL` | Email de la cuenta de Atlassian con la que se lee Jira |
| `JIRA_API_TOKEN` | Token de API **con alcances** de esa cuenta (id.atlassian.com → Seguridad → Tokens de API), app Jira, alcances `read:jira-work` y `write:jira-work`. Por eso el workflow usa `api.atlassian.com/ex/jira/<cloudId>` y no la URL del sitio |
| `CLAUDE_<AGENTE>_URL` | URL `.../routines/<trigger>/fire` de la rutina de Claude del agente |
| `CLAUDE_<AGENTE>_TOKEN` | Token de API de esa rutina |

`<AGENTE>`: `RAPIDO`, `ANALIZADOR`, `PLANIFICADOR`, `IMPLEMENTADOR`, `REVISOR`.

## Repo público

Los minutos de GitHub Actions son gratis en repos públicos. Nada sensible está en el código, y los registros solo muestran recuentos, nunca claves de ticket, títulos ni respuestas. No añadas disparos `pull_request_target` ni nada que ejecute código de terceros con los secretos.

## Probar

- `npm test`: lógica de selección.
- Actions → «Disparador Jira → agentes (rutinas de Claude)» → Run workflow con «Simulación» marcada: busca cambios sin llamar a ningún agente.
