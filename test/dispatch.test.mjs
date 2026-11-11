import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectDispatches, pruneProcessed, relayActive } from '../src/dispatch.mjs';

const now = new Date('2026-11-07T10:00:00Z');
const ago = (min) => new Date(now.getTime() - min * 60_000).toISOString();
const change = (id, min, to) => ({ id, created: ago(min), items: [{ field: 'status', toString: to }] });
const comment = (id, min) => ({ id, created: ago(min), items: [{ field: 'comment', toString: 'x' }] });
const state = (extra = {}) => ({ since: ago(600), processed: {}, ...extra });

test('dispara el agente al entrar en un estado con agente', () => {
  const issues = [{ key: 'KAN-1', status: 'Implementando', changelog: [change('10', 3, 'Implementando')] }];
  const { dispatches, seen } = selectDispatches(issues, state(), now);
  assert.deepEqual(dispatches, [{ key: 'KAN-1', agent: 'IMPLEMENTADOR', status: 'Implementando', changeId: '10' }]);
  assert.deepEqual(seen, ['10']);
});

test('no repite un cambio ya procesado aunque el ticket siga en el estado', () => {
  const issues = [{ key: 'KAN-1', status: 'Implementando', changelog: [change('10', 30, 'Implementando'), comment('11', 5)] }];
  const { dispatches } = selectDispatches(issues, state({ processed: { 10: ago(25) } }), now);
  assert.equal(dispatches.length, 0);
});

test('solo cuenta el último cambio de estado', () => {
  const issues = [{ key: 'KAN-1', status: 'Revisando código', changelog: [change('10', 20, 'Implementando'), change('12', 2, 'Revisando código')] }];
  const { dispatches } = selectDispatches(issues, state(), now);
  assert.deepEqual(dispatches.map((d) => d.agent), ['REVISOR']);
});

test('no dispara si el ticket ya salió del estado', () => {
  const issues = [{ key: 'KAN-1', status: 'PR mezclado', changelog: [change('10', 2, 'Revisando código')] }];
  const { dispatches, seen } = selectDispatches(issues, state(), now);
  assert.equal(dispatches.length, 0);
  assert.deepEqual(seen, ['10']);
});

test('ignora cambios anteriores a la instalación (since)', () => {
  const issues = [{ key: 'KAN-1', status: 'Analizando', changelog: [change('10', 20, 'Analizando')] }];
  const { dispatches } = selectDispatches(issues, state({ since: ago(10) }), now);
  assert.equal(dispatches.length, 0);
});

test('ignora cambios fuera de la ventana de búsqueda', () => {
  const issues = [{ key: 'KAN-1', status: 'Analizando', changelog: [change('10', 2000, 'Analizando'), comment('11', 1)] }];
  const { dispatches } = selectDispatches(issues, state({ since: ago(10_000) }), now);
  assert.equal(dispatches.length, 0);
});

test('correcciones de código va al implementador y entrada rápida al agente rápido', () => {
  const issues = [
    { key: 'KAN-1', status: 'Correcciones de código', changelog: [change('10', 1, 'Correcciones de código')] },
    { key: 'KAN-2', status: 'Entrada rápida', changelog: [change('20', 1, 'Entrada rápida')] },
  ];
  assert.deepEqual(selectDispatches(issues, state(), now).dispatches.map((d) => d.agent), ['IMPLEMENTADOR', 'RAPIDO']);
});

test('estados sin agente no disparan', () => {
  const issues = [{ key: 'KAN-1', status: 'Probando', changelog: [change('10', 1, 'Probando')] }];
  assert.equal(selectDispatches(issues, state(), now).dispatches.length, 0);
});

test('limpia los procesados de hace más de 3 días', () => {
  assert.deepEqual(Object.keys(pruneProcessed({ a: ago(60), b: ago(5 * 1440) }, now)), ['a']);
});

const label = (id, min, from, to) => ({ id, created: ago(min), items: [{ field: 'labels', fromString: from, toString: to }] });

test('ignora tickets en relevo de Claude y no los marca como vistos', () => {
  const issues = [{ key: 'KAN-1', status: 'Revisando código', labels: ['relevo-claude'],
    changelog: [label('9', 30, '', 'relevo-claude'), change('10', 5, 'Revisando código')] }];
  const { dispatches, seen } = selectDispatches(issues, state(), now);
  assert.equal(dispatches.length, 0);
  assert.equal(seen.length, 0);
});

test('al quitar la etiqueta de relevo dispara el cambio pendiente', () => {
  const issues = [{ key: 'KAN-1', status: 'Revisando código', labels: [],
    changelog: [label('9', 30, '', 'relevo-claude'), change('10', 5, 'Revisando código'), label('11', 1, 'relevo-claude', '')] }];
  assert.deepEqual(selectDispatches(issues, state(), now).dispatches.map((d) => d.agent), ['REVISOR']);
});

test('una etiqueta de relevo de más de 6 horas se da por abandonada', () => {
  const stale = { labels: ['relevo-claude'], changelog: [label('9', 7 * 60, 'complejo', 'complejo relevo-claude')] };
  const fresh = { labels: ['relevo-claude'], changelog: [label('9', 60, '', 'relevo-claude')] };
  assert.equal(relayActive(stale, now), false);
  assert.equal(relayActive(fresh, now), true);
});
