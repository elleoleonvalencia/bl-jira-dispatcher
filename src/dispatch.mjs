// Disparador Jira → agentes (rutinas de Claude Code). Sustituye a las reglas de Jira Automation del pipeline de agentes.
//
// Cada pasada busca los tickets que han ENTRADO en un estado con agente (no los que siguen en él),
// llama a la rutina de Claude Code de ese agente una sola vez por cambio y guarda en state.json los cambios
// ya disparados. Los registros son públicos: no se escriben claves de ticket, títulos ni respuestas.

import { readFile, writeFile } from 'node:fs/promises';

// Proyectos de Jira con su interruptor (projects.json). Un proyecto apagado no se consulta.
// "since": desde cuándo se disparan sus cambios; al encender un proyecto se pone la hora de encendido,
// para que no se disparen de golpe los cambios de estado anteriores.
export function enabledProjects(projects) {
  return Object.entries(projects).filter(([, p]) => p.enabled).map(([key]) => key);
}

export const projectOf = (key) => key.replace(/-\d+$/, '');

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
export const RELAY_LABEL = 'relevo-claude';
const RELAY_STALE_HOURS = 6; // un relevo nocturno nunca dura tanto: pasado este tiempo la etiqueta se da por abandonada

/**
 * Decide qué disparar. Pura: sin red ni ficheros (se prueba en test/dispatch.test.mjs).
 * - issues: [{ key, status, changelog: [{ id, created, items: [{ field, toString }] }] }]
 * - Solo cuenta el ÚLTIMO cambio de estado de cada ticket, y solo si el ticket sigue en ese estado
 *   (si ya salió, otro agente o una persona se encargó).
 * - Ignora cambios anteriores a state.since y los ya procesados.
 */
export function selectDispatches(issues, state, now = new Date(), projects = null) {
  const since = new Date(state.since);
  const windowStart = new Date(now.getTime() - LOOKBACK_MINUTES * 60_000);
  const globalFrom = since > windowStart ? since : windowStart;
  const dispatches = [];
  const seen = [];
  for (const issue of issues) {
    // Relevo de Claude en curso: no se toca (ni se marca como visto, para dispararlo cuando acabe).
    if (relayActive(issue, now)) continue;
    let from = globalFrom;
    if (projects) {
      const p = projects[projectOf(issue.key)];
      if (!p?.enabled || !p.since) continue; // proyecto apagado o sin hora de encendido: nada
      const projectSince = new Date(p.since);
      if (projectSince > from) from = projectSince;
    }
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

/** La etiqueta relevo-claude cuenta solo si se puso hace menos de RELAY_STALE_HOURS (si se cortó el relevo, caduca). */
export function relayActive(issue, now = new Date()) {
  if (!(issue.labels ?? []).includes(RELAY_LABEL)) return false;
  const added = issue.changelog
    .filter((h) => h.items.some((i) => i.field === 'labels' && (i.toString ?? '').split(' ').includes(RELAY_LABEL)
      && !(i.fromString ?? '').split(' ').includes(RELAY_LABEL)))
    .map((h) => new Date(h.created))
    .sort((a, b) => b - a)[0];
  if (!added) return true; // no se ve cuándo se puso (historial largo): por prudencia, se respeta
  return now - added < RELAY_STALE_HOURS * 3_600_000;
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

async function recentIssues(projectKeys) {
  const statuses = Object.keys(AGENT_BY_STATUS).map((s) => `"${s}"`).join(', ');
  const jql = `project in (${projectKeys.join(', ')}) AND status in (${statuses}) AND updated >= "-${LOOKBACK_MINUTES}m"`;
  const out = [];
  let nextPageToken;
  do {
    const page = await jira('/rest/api/3/search/jql', {
      method: 'POST',
      body: JSON.stringify({ jql, fields: ['status', 'labels'], maxResults: 100, nextPageToken }),
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

// Rutina de Claude Code del agente: CLAUDE_<PROYECTO>_<AGENTE>_URL si existe, si no CLAUDE_<AGENTE>_URL
// (la URL .../routines/<trigger>/fire), cada una con su _TOKEN.
export function routineVars(agent, project, envVars = process.env) {
  for (const prefix of [`CLAUDE_${project}_${agent}`, `CLAUDE_${agent}`]) {
    if (envVars[`${prefix}_URL`]) return { url: `${prefix}_URL`, token: `${prefix}_TOKEN` };
  }
  return null;
}

export const ROUTINE_HEADERS = {
  'anthropic-beta': 'experimental-cc-routine-2026-04-01',
  'anthropic-version': '2023-06-01',
  'Content-Type': 'application/json',
};

export function routineText(agent, issue) {
  return `Ticket ${issue.key} (proyecto ${projectOf(issue.key)}) en estado «${issue.fields?.status?.name ?? '?'}». ` +
    `Agente: ${agent.toLowerCase()}. Título: ${issue.fields?.summary ?? ''}`;
}

async function post(url, headers, body) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, { method: 'POST', headers, body });
      if (res.ok) return { ok: true, status: res.status };
      if (attempt === 2) return { ok: false, status: res.status };
    } catch (e) {
      if (attempt === 2) return { ok: false, status: 'sin respuesta' };
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

async function callAgent(agent, issueKey) {
  const routine = routineVars(agent, projectOf(issueKey));
  if (!routine) return { ok: false, status: `sin rutina configurada (falta CLAUDE_${agent}_URL)` };
  const issue = await jira(`/rest/api/3/issue/${issueKey}?fields=summary,status`);
  return post(env(routine.url), { ...ROUTINE_HEADERS, Authorization: `Bearer ${env(routine.token)}` },
    JSON.stringify({ text: routineText(agent, issue) }));
}

async function commentError(key, status, httpStatus) {
  const text = `[IA:ERROR] El disparador (bl-jira-dispatcher) no pudo lanzar el agente (rutina de Claude Code) al entrar en «${status}». Respuesta: ${httpStatus}. Para reintentar, saca el ticket del estado y vuelve a meterlo.`;
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
  const projects = JSON.parse(await readFile(new URL('../projects.json', import.meta.url), 'utf8'));
  const now = new Date();
  const keys = enabledProjects(projects);
  if (keys.length === 0) {
    console.log('Ningún proyecto encendido en projects.json. No se hace nada.');
    return;
  }

  const found = await recentIssues(keys);
  const issues = [];
  for (const i of found) {
    issues.push({ key: i.key, status: i.fields.status.name, labels: i.fields.labels ?? [], changelog: await lastChangelog(i.key) });
  }
  const { dispatches, seen } = selectDispatches(issues, state, now, projects);

  let ok = 0;
  let failed = 0;
  try {
    for (const d of dispatches) {
      if (dryRun) continue;
      const r = await callAgent(d.agent, d.key);
      state.processed[d.changeId] = now.toISOString(); // disparado (o fallido y avisado): no repetir
      if (r.ok) ok++;
      else {
        failed++;
        console.log(`Fallo al llamar al agente ${d.agent} (respuesta ${r.status}).`);
        await commentError(d.key, d.status, r.status).catch(() => console.log('Tampoco se pudo comentar el error en Jira.'));
      }
    }
  } finally {
    console.log(`Proyectos: ${keys.length} · tickets revisados: ${issues.length} · disparos: ${dispatches.length}${dryRun ? ' (simulación, no se llamó a ningún agente)' : ` · ok: ${ok} · fallidos: ${failed}`}`);
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
