// Watchlist storage: Firestore (per anonymous user) when Firebase is configured,
// chrome.storage.local in mock mode or when Firestore is unreachable.

import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  setDoc,
  type Firestore,
} from 'firebase/firestore';
import type { ChecklistItem, WatchedTender } from '../core/types';
import { getFirebaseApp } from '../firebase/app';
import { ensureUser } from '../firebase/services';

export interface WatchStore {
  kind: 'firestore' | 'local';
  list(): Promise<WatchedTender[]>;
  save(t: WatchedTender): Promise<void>;
  remove(id: string): Promise<void>;
  updateChecklist(id: string, checklist: ChecklistItem[]): Promise<void>;
}

const byDeadline = (a: WatchedTender, b: WatchedTender) =>
  (a.deadline ? Date.parse(a.deadline) : Infinity) - (b.deadline ? Date.parse(b.deadline) : Infinity);

class LocalStore implements WatchStore {
  kind = 'local' as const;
  private async all(): Promise<Record<string, WatchedTender>> {
    const { watchlist = {} } = await chrome.storage.local.get('watchlist');
    return watchlist as Record<string, WatchedTender>;
  }
  async list() {
    return Object.values(await this.all()).sort(byDeadline);
  }
  async save(t: WatchedTender) {
    const all = await this.all();
    all[t.id] = t;
    await chrome.storage.local.set({ watchlist: all });
  }
  async remove(id: string) {
    const all = await this.all();
    delete all[id];
    await chrome.storage.local.set({ watchlist: all });
  }
  async updateChecklist(id: string, checklist: ChecklistItem[]) {
    const all = await this.all();
    if (all[id]) {
      all[id] = { ...all[id], checklist, updatedAt: new Date().toISOString() };
      await chrome.storage.local.set({ watchlist: all });
    }
  }
}

class FirestoreStore implements WatchStore {
  kind = 'firestore' as const;
  constructor(private db: Firestore, private uid: string) {}
  private col() {
    return collection(this.db, 'users', this.uid, 'tenders');
  }
  async list() {
    const snap = await getDocs(this.col());
    return snap.docs.map((d) => d.data() as WatchedTender).sort(byDeadline);
  }
  async save(t: WatchedTender) {
    await setDoc(doc(this.col(), t.id), t, { merge: true });
  }
  async remove(id: string) {
    await deleteDoc(doc(this.col(), id));
  }
  async updateChecklist(id: string, checklist: ChecklistItem[]) {
    await setDoc(doc(this.col(), id), { checklist, updatedAt: new Date().toISOString() }, { merge: true });
  }
}

let store: Promise<WatchStore> | null = null;
let db: Firestore | null = null;

export function getStore(): Promise<WatchStore> {
  store ??= (async () => {
    const app = getFirebaseApp();
    if (!app) return new LocalStore();
    try {
      const user = await ensureUser();
      if (!user) return new LocalStore();
      // Persistent cache: the watchlist opens offline, writes sync when the connection is back.
      db ??= initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
      return new FirestoreStore(db, user.uid);
    } catch (e) {
      console.warn('[Tender Lens] Firestore/Auth unavailable, using local storage', e);
      return new LocalStore();
    }
  })();
  return store;
}
