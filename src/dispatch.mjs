// Disparador Jira → Cursor. Sustituye a las reglas de Jira Automation del pipeline de agentes.
//
// Cada pasada busca los tickets que han ENTRADO en un estado con agente (no los que siguen en él),
// llama al webhook de Cursor de ese agente una sola vez por cambio y guarda en state.json los cambios
// ya disparados. Los registros son públicos: no se escriben claves de ticket, títulos ni respuestas.

import { readFile, writeFile } from 'node:fs/promises';

// Estado de Jira → agente. Los nombres deben coincidir EXACTAMENTE con los del tablero.
export const AGENT_BY_STATUS = {
  'Entrada rápida': 'RAPIDO',
  'Analizando': 'ANALIZADOR',
  'Planificando': 'PLANIFICADOR',
  'Implementando': 'IMPLEMENTADOR',
  'Correcciones de código': 'IMPLEMENTADOR',
  'Revisando código': 'REVISOR',
};

const LOOKBACK_MINUTES = 1440; // 24 h: cubre retrasos y pasadas perdidas; no repite gracias a state.processed
const KEEP_PROCESSED_DAYS = 3;

/**
 * Decide qué disparar. Pura: sin red ni ficheros (se prueba en test/dispatch.test.mjs).
 * - issues: [{ key, status, changelog: [{ id, created, items: [{ field, toString }] }] }]
 * - Solo cuenta el ÚLTIMO cambio de estado de cada ticket, y solo si el ticket sigue en ese estado
 *   (si ya salió, otro agente o una persona se encargó).
 * - Ignora cambios anteriores a state.since y los ya procesados.
 */
export function selectDispatches(issues, state, now = new Date()) {
  const since = new Date(state.since);
  const windowStart = new Date(now.getTime() - LOOKBACK_MINUTES * 60_000);
  const from = since > windowStart ? since : windowStart;
  const dispatches = [];
  const seen = [];
  for (const issue of issues) {
    const statusChanges = issue.changelog
      .filter((h) => h.items.some((i) => i.field === 'status'))
      .sort((a, b) => new Date(a.created) - new Date(b.created));
    const last = statusChanges.at(-1);
    if (!last) continue;
    const to = last.items.find((i) => i.field === 'status').toString;
    if (new Date(last.created) < from) continue;
    if (state.processed[last.id]) continue;
    seen.push(last.id);
    const agent = AGENT_BY_STATUS[to];
    if (!agent || issue.status !== to) continue;
    dispatches.push({ key: issue.key, agent, status: to, changeId: last.id });
  }
  return { dispatches, seen };
}

export function pruneProcessed(processed, now = new Date()) {
  const limit = now.getTime() - KEEP_PROCESSED_DAYS * 86_400_000;
  return Object.fromEntries(Object.entries(processed).filter(([, at]) => new Date(at).getTime() >= limit));
}

function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Falta la variable ${name}`);
  return v;
}

async function jira(path, init = {}) {
  const base = env('JIRA_BASE_URL').replace(/\/$/, '');
  const auth = Buffer.from(`${env('JIRA_EMAIL')}:${env('JIRA_API_TOKEN')}`).toString('base64');
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json', 'Content-Type': 'application/json', ...init.headers },
  });
  if (!res.ok) throw new Error(`Jira respondió ${res.status} en ${path.split('?')[0].replace(/[A-Z]+-\d+/g, '<ticket>')}`);
  return res.status === 204 ? null : res.json();
}

async function recentIssues() {
  const statuses = Object.keys(AGENT_BY_STATUS).map((s) => `"${s}"`).join(', ');
  const jql = `project = ${env('JIRA_PROJECT')} AND status in (${statuses}) AND updated >= "-${LOOKBACK_MINUTES}m"`;
  const out = [];
  let nextPageToken;
  do {
    const page = await jira('/rest/api/3/search/jql', {
      method: 'POST',
      body: JSON.stringify({ jql, fields: ['status'], maxResults: 100, nextPageToken }),
    });
    out.push(...page.issues);
    nextPageToken = page.isLast ? undefined : page.nextPageToken;
  } while (nextPageToken);
  return out;
}

async function lastChangelog(key) {
  const head = await jira(`/rest/api/3/issue/${key}/changelog?maxResults=1`);
  const startAt = Math.max(0, head.total - 50);
  const page = await jira(`/rest/api/3/issue/${key}/changelog?startAt=${startAt}&maxResults=50`);
  return page.values.map((h) => ({ id: h.id, created: h.created, items: h.items }));
}

async function callCursor(agent, issueKey) {
  // Mismo contenido que la regla de Jira («Datos de la incidencia»): el agente lee issue.key.
  const issue = await jira(`/rest/api/3/issue/${issueKey}?fields=summary,status,issuetype,parent,labels,priority,project`);
  const body = JSON.stringify({ issue, source: 'bl-jira-dispatcher' });
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(env(`CURSOR_${agent}_URL`), {
        method: 'POST',
        headers: { Authorization: `Bearer ${env(`CURSOR_${agent}_TOKEN`)}`, 'Content-Type': 'application/json' },
        body,
      });
      if (res.ok) return { ok: true, status: res.status };
      if (attempt === 2) return { ok: false, status: res.status };
    } catch (e) {
      if (attempt === 2) return { ok: false, status: 'sin respuesta' };
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

async function commentError(key, status, httpStatus) {
  const text = `[IA:ERROR] El disparador (bl-jira-dispatcher) no pudo lanzar el agente en Cursor al entrar en «${status}». Respuesta: ${httpStatus}. Para reintentar, saca el ticket del estado y vuelve a meterlo.`;
  await jira(`/rest/api/3/issue/${key}/comment`, {
    method: 'POST',
    body: JSON.stringify({ body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } }),
  });
}

async function main() {
  if (!process.env.JIRA_API_TOKEN) {
    console.log('Sin configurar: faltan los secretos. No se hace nada.');
    return;
  }
  const dryRun = process.env.DRY_RUN === 'true';
  const statePath = new URL('../state.json', import.meta.url);
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const now = new Date();

  const found = await recentIssues();
  const issues = [];
  for (const i of found) {
    issues.push({ key: i.key, status: i.fields.status.name, changelog: await lastChangelog(i.key) });
  }
  const { dispatches, seen } = selectDispatches(issues, state, now);

  let ok = 0;
  let failed = 0;
  try {
    for (const d of dispatches) {
      if (dryRun) continue;
      const r = await callCursor(d.agent, d.key);
      state.processed[d.changeId] = now.toISOString(); // disparado (o fallido y avisado): no repetir
      if (r.ok) ok++;
      else {
        failed++;
        console.log(`Fallo al llamar al agente ${d.agent} (respuesta ${r.status}).`);
        await commentError(d.key, d.status, r.status).catch(() => console.log('Tampoco se pudo comentar el error en Jira.'));
      }
    }
  } finally {
    console.log(`Tickets revisados: ${issues.length} · disparos: ${dispatches.length}${dryRun ? ' (simulación, no se llamó a Cursor)' : ` · ok: ${ok} · fallidos: ${failed}`}`);
    if (!dryRun && seen.length > 0) {
      // Los cambios que no tocaba disparar se marcan ya; los disparos solo cuando se hicieron (arriba).
      const toDispatch = new Set(dispatches.map((d) => d.changeId));
      for (const id of seen) if (!toDispatch.has(id)) state.processed[id] ??= now.toISOString();
      state.processed = pruneProcessed(state.processed, now);
      await writeFile(statePath, JSON.stringify(state, null, 2) + '\n');
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.log(`Error: ${e.message}`);
    process.exit(1);
  });
}
