# bl-jira-dispatcher

Lanza los agentes de IA de Cursor cuando un ticket de Jira (proyecto KAN, BL Nutrition) entra en un estado con agente. Sustituye a las reglas de Jira Automation, que en el plan gratuito de Jira se quedan sin pasos.

## Cómo funciona

Cada 5 minutos (GitHub Actions, `.github/workflows/dispatch.yml`):

1. Busca en Jira los tickets actualizados en las últimas 3 horas que están en un estado con agente.
2. Mira el **último cambio de estado** de cada uno. Si es nuevo (no está en `state.json`) y el ticket sigue en ese estado, llama al webhook de Cursor del agente. Un ticket que sigue parado en un estado no vuelve a disparar.
3. Si Cursor no responde bien tras dos intentos, comenta `[IA:ERROR]` en el ticket.
4. Guarda en `state.json` los cambios ya disparados (se limpian a los 3 días).

| Estado | Agente |
|---|---|
| Entrada rápida | Agente rápido |
| Analizando | Analizador |
| Planificando | Planificador |
| Implementando, Correcciones de código | Implementador |
| Revisando código | Revisor |

Para relanzar un agente: saca el ticket del estado y vuelve a meterlo.

## Secretos (Settings → Secrets and variables → Actions)

| Secreto | Qué es |
|---|---|
| `JIRA_EMAIL` | Email de la cuenta de Atlassian con la que se lee Jira |
| `JIRA_API_TOKEN` | Token de API **con alcances** de esa cuenta (id.atlassian.com → Seguridad → Tokens de API), app Jira, alcances `read:jira-work` y `write:jira-work`. Por eso el workflow usa `api.atlassian.com/ex/jira/<cloudId>` y no la URL del sitio |
| `CURSOR_<AGENTE>_URL` | URL del webhook de la automatización de Cursor |
| `CURSOR_<AGENTE>_TOKEN` | Token de esa automatización, sin la palabra `Bearer` |

`<AGENTE>`: `RAPIDO`, `ANALIZADOR`, `PLANIFICADOR`, `IMPLEMENTADOR`, `REVISOR`.

## Repo público

Los minutos de GitHub Actions son gratis en repos públicos. Nada sensible está en el código, y los registros solo muestran recuentos, nunca claves de ticket, títulos ni respuestas. No añadas disparos `pull_request_target` ni nada que ejecute código de terceros con los secretos.

## Probar

- `npm test`: lógica de selección.
- Actions → «Disparador Jira → Cursor» → Run workflow con «Simulación» marcada: busca cambios sin llamar a Cursor.
