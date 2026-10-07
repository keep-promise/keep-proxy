'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** 转发规则的持久化存储（JSON 文件，原子写入）+ 内存统计 */
class RuleStore {
  constructor(file) {
    this.file = file;
    this.stats = new Map(); // id -> { hits, errors, lastHitAt, totalDurationMs }
    this.totalHits = 0;
    this.totalErrors = 0;
    this.rules = this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.rules, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  list() {
    return this.rules;
  }

  get(id) {
    return this.rules.find((r) => r.id === id) || null;
  }

  create(data) {
    const now = new Date().toISOString();
    const rule = { ...data, id: crypto.randomUUID(), createdAt: now, updatedAt: now };
    this.rules.push(rule);
    this.persist();
    return rule;
  }

  update(id, patch) {
    const rule = this.get(id);
    if (!rule) return null;
    Object.assign(rule, patch, { id, createdAt: rule.createdAt, updatedAt: new Date().toISOString() });
    this.persist();
    return rule;
  }

  remove(id) {
    const i = this.rules.findIndex((r) => r.id === id);
    if (i < 0) return false;
    this.rules.splice(i, 1);
    this.persist();
    return true;
  }

  toggle(id) {
    const rule = this.get(id);
    if (!rule) return null;
    rule.enabled = !rule.enabled;
    rule.updatedAt = new Date().toISOString();
    this.persist();
    return rule;
  }

  duplicate(id) {
    const rule = this.get(id);
    if (!rule) return null;
    const copy = JSON.parse(JSON.stringify(rule));
    delete copy.id;
    copy.name = `${rule.name} (副本)`;
    copy.enabled = false;
    return this.create(copy);
  }

  reload() {
    this.rules = this.load();
    return this.rules.length;
  }

  recordHit(id, ok, durationMs) {
    this.totalHits++;
    if (!ok) this.totalErrors++;
    const s = this.stats.get(id) || { hits: 0, errors: 0, lastHitAt: null, totalDurationMs: 0 };
    s.hits++;
    if (!ok) s.errors++;
    s.lastHitAt = Date.now();
    s.totalDurationMs += durationMs || 0;
    this.stats.set(id, s);
  }

  statView() {
    const zero = { hits: 0, errors: 0, lastHitAt: null, totalDurationMs: 0 };
    const rules = this.rules.map((r) => {
      const s = this.stats.get(r.id) || zero;
      return {
        id: r.id,
        name: r.name,
        enabled: !!r.enabled,
        path: r.match && r.match.path,
        mappingType: (r.mapping && r.mapping.type) || 'none',
        targetUrl: r.target && r.target.url,
        ...s,
        avgMs: s.hits ? Math.round(s.totalDurationMs / s.hits) : 0,
      };
    });
    return {
      totalRules: this.rules.length,
      enabledRules: this.rules.filter((r) => r.enabled).length,
      totalHits: this.totalHits,
      totalErrors: this.totalErrors,
      rules,
    };
  }
}

module.exports = { RuleStore };
