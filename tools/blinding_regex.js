/**
 * Blinding pattern for the e2e suites (tools/e2e.js, tools/e2e_gc.js): the JS twin of tools/cases_lib/blinding.py.
 * Built from cases/models.json (every model's code as a whole word, its name and aliases ignoring case / spaces / hyphens /
 * underscores), common vendor words, and the GC run ids of the active set (gc/data/gc_items.js units[].run, plus their
 * model-specific fragments). A code at the start of a compound term ('alpha-glucosidase') is not a hit.
 *   const { blindingRegex } = require('./blinding_regex');  const re = blindingRegex();  re.test(text)
 * Pass { source, flags } into page.evaluate when the check runs in the browser.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const VENDOR_WORDS = ['openai', 'chatgpt', 'anthropic', 'claude', 'gemini', 'deepseek', 'llama', 'mistral', 'qwen', 'gpt', 'copilot'];
const norm = s => String(s || '').toLowerCase().replace(/[\s_\-]+/g, '');
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const flex = s => Array.from(norm(s)).map(esc).join('[\\s_\\-]*');
const B0 = '(?<![A-Za-z0-9])', B1 = '(?![A-Za-z0-9])';

function loadWindow(rel) {
  const w = {};
  try { vm.runInNewContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), { window: w }); } catch (e) { /* missing file → no runs */ }
  return w;
}

function blindingTerms() {
  const models = JSON.parse(fs.readFileSync(path.join(ROOT, 'cases', 'models.json'), 'utf8')).models || [];
  const parts = [];
  const codes = new Set();
  models.forEach(m => {
    codes.add(m.code);
    [m.name].concat(m.aliases || []).filter(a => a && norm(a) && norm(a) !== m.code).forEach(a => parts.push(B0 + flex(a) + B1));
    parts.push('(?<![A-Za-z]-)' + B0 + esc(m.code) + B1 + '(?!-[A-Za-z])');
  });
  VENDOR_WORDS.filter(w => !codes.has(w)).forEach(w => parts.push(B0 + esc(w) + B1));
  // GC run ids of the active set and their fragments that belong to one model only (letters + digits, 5+ chars)
  const G = loadWindow('gc/data/gc_items.js').GC_DATA || { units: {} };
  const frags = {};
  Object.values(G.units || {}).forEach(u => {
    if (!u.run) return;
    parts.push(B0 + esc(u.run) + B1);
    u.run.split(/[_\-.\s]+/).filter(f => f.length >= 5 && /[A-Za-z]/.test(f) && /\d/.test(f)).forEach(f => {
      (frags[f.toLowerCase()] = frags[f.toLowerCase()] || new Set()).add(u.model);
    });
  });
  Object.keys(frags).filter(f => frags[f].size === 1).forEach(f => parts.push(B0 + esc(f) + B1));
  return parts;
}

function blindingRegex() {
  return new RegExp(blindingTerms().join('|'), 'i');
}

module.exports = { blindingRegex, blindingTerms, VENDOR_WORDS };
