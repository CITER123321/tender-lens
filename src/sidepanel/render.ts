// DOM rendering. All page-derived and model-derived strings go through textContent, never innerHTML.

import { formatDeadline, timeLeft } from '../core/normalize';
import type { AnalysisResult, ChecklistItem, Engine, WatchedTender } from '../core/types';

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {}, ...children: (Node | string | null | undefined)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const c of children) if (c !== null && c !== undefined) node.append(c);
  return node;
}

export const ENGINE_LABEL: Record<Engine, string> = {
  'on-device': 'On device · Gemini Nano',
  cloud: 'Cloud · Gemini via Firebase AI Logic',
  mock: 'Mock · parser only',
};

export function countdown(deadline: string | null): { text: string; urgent: boolean } {
  if (!deadline) return { text: 'Not found in the notice', urgent: false };
  const left = timeLeft(deadline);
  if (left.past) return { text: 'Deadline passed', urgent: true };
  const text = left.days > 0 ? `${left.days} day${left.days === 1 ? '' : 's'} ${left.hours} h left` : `${left.hours} h left`;
  return { text, urgent: left.days < 3 };
}

export interface ResultHandlers {
  watched: boolean;
  checklist: ChecklistItem[];
  onToggle(id: string, done: boolean): void;
  onWatch(): void;
  onIcs(): void;
  onCopy(): void;
}

export function renderResult(host: HTMLElement, r: AnalysisResult, h: ResultHandlers): void {
  const tpl = document.getElementById('tpl-result') as HTMLTemplateElement;
  const frag = tpl.content.cloneNode(true) as DocumentFragment;
  const q = <T extends Element = HTMLElement>(sel: string) => frag.querySelector(sel) as T;
  const s = r.summary;

  q('.engine').setAttribute('data-engine', r.engine);
  q('.engine-pill').textContent = ENGINE_LABEL[r.engine];
  q('.engine-meta').textContent = `${r.model} · ${(r.ms / 1000).toFixed(1)} s`;
  q('.route').textContent = r.route.reason;

  q('.title').textContent = s.title || 'Untitled notice';
  q('.buyer').textContent = s.buyer;
  q('.ref').textContent = s.reference;

  const dl = q('.deadline');
  const cd = countdown(s.deadline);
  q('.deadline .value').textContent = s.deadline ? formatDeadline(s.deadline) : '—';
  q('.deadline .sub').textContent = cd.text;
  dl.classList.toggle('urgent', cd.urgent);
  q('.deposit .value').textContent =
    s.deposit.required === true ? s.deposit.amount ?? 'Required (amount in the specification)' : s.deposit.required === false ? 'Not required' : 'Not stated';

  if (r.conflicts.length) {
    const box = q('.conflicts');
    box.hidden = false;
    box.textContent = r.conflicts
      .map((c) => `Check the ${c.field}: the parser read "${c.parser}", the model read "${c.model}". Showing the parser value.`)
      .join(' ');
  }
  q('.summary').textContent = s.summary;

  const fill = (sel: string, items: string[]) => {
    if (!items.length) return;
    const sec = q(sel);
    sec.hidden = false;
    const ul = sec.querySelector('ul')!;
    for (const it of items) ul.append(el('li', { textContent: it }));
  };
  fill('.flags', s.redFlags);
  fill('.conditions', s.conditions);

  if (s.criteria.length) {
    const sec = q('.criteria');
    sec.hidden = false;
    const ul = sec.querySelector('ul')!;
    for (const c of s.criteria) {
      const bar = el('div', { className: 'bar' }, el('span'));
      (bar.firstChild as HTMLElement).style.width = `${Math.min(100, Math.max(0, c.weight ?? 0))}%`;
      ul.append(el('li', { className: 'crit' }, el('span', { textContent: c.name }), el('b', { textContent: c.weight === null ? '?' : `${c.weight}%` }), bar));
    }
  }

  renderChecklist(q('.checklist'), h.checklist, h.onToggle);

  const ev = q('.evidence ul');
  const entries = Object.entries(r.facts.evidence);
  if (entries.length) for (const [k, v] of entries) ev.append(el('li', {}, el('b', { textContent: `${k}: ` }), v));
  else q<HTMLElement>('.evidence').hidden = true;

  const watchBtn = q<HTMLButtonElement>('.act-watch');
  watchBtn.textContent = h.watched ? 'Watching ✓' : 'Watch';
  watchBtn.addEventListener('click', h.onWatch);
  const icsBtn = q<HTMLButtonElement>('.act-ics');
  icsBtn.disabled = !s.deadline;
  icsBtn.addEventListener('click', h.onIcs);
  q<HTMLButtonElement>('.act-copy').addEventListener('click', h.onCopy);

  host.replaceChildren(frag);
  host.hidden = false;
}

export function renderChecklist(section: Element, items: ChecklistItem[], onToggle: (id: string, done: boolean) => void): void {
  const ul = section.querySelector('ul')!;
  ul.replaceChildren();
  const progress = section.querySelector('.progress-text');
  const update = () => {
    if (progress) progress.textContent = `${items.filter((i) => i.done).length}/${items.length}`;
  };
  for (const item of items) {
    const box = el('input', { type: 'checkbox', checked: item.done });
    const li = el('li', { className: item.done ? 'done' : '' }, el('label', {}, box, el('span', { textContent: item.text })));
    box.addEventListener('change', () => {
      item.done = box.checked;
      li.className = item.done ? 'done' : '';
      update();
      onToggle(item.id, item.done);
    });
    ul.append(li);
  }
  update();
}

export interface WatchHandlers {
  onOpen(t: WatchedTender): void;
  onIcs(t: WatchedTender): void;
  onRemove(t: WatchedTender): void;
  onToggle(t: WatchedTender, id: string, done: boolean): void;
}

export function renderWatchlist(ul: HTMLElement, items: WatchedTender[], h: WatchHandlers): void {
  ul.replaceChildren();
  for (const t of items) {
    const cd = countdown(t.deadline);
    const done = t.checklist.filter((c) => c.done).length;
    const chip = el('span', { className: `chip ${cd.urgent ? 'warn' : 'ok'}`, textContent: cd.text });
    const details = el('details', {}, el('summary', { className: 'small muted', textContent: `Checklist ${done}/${t.checklist.length}` }), el('ul'));
    const section = el('div', {}, details);
    renderChecklist(details, t.checklist, (id, d) => h.onToggle(t, id, d));
    const open = el('button', { className: 'ghost', textContent: 'Open notice' });
    open.addEventListener('click', () => h.onOpen(t));
    const ics = el('button', { className: 'ghost', textContent: '.ics', disabled: !t.deadline });
    ics.addEventListener('click', () => h.onIcs(t));
    const rm = el('button', { className: 'ghost', textContent: 'Remove' });
    rm.addEventListener('click', () => h.onRemove(t));
    ul.append(
      el(
        'li',
        { className: 'card watch-item' },
        el('header', {}, el('h4', { textContent: t.title || t.url }), chip),
        el('div', { className: 'meta muted' }, el('span', { textContent: t.buyer }), t.deadline ? el('span', { textContent: `· ${formatDeadline(t.deadline)}` }) : null),
        section,
        el('div', { className: 'actions' }, open, ics, rm),
      ),
    );
  }
}
