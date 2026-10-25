// IndexedDB 极简封装：存用户导入的 Live2D 模型 zip（体积大、
// 二进制，不适合进 localStorage / backend momo.yaml）。
// 浏览器外（测试环境）所有调用静默降级为 miss/no-op。

const DB_NAME = "momo-web";
const DB_VERSION = 1;
const STORE = "avatars";

const hasIdb = (): boolean => typeof indexedDB !== "undefined";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error ?? new Error("indexedDB open failed"));
    };
  });
  return dbPromise;
}

function run<T>(
  mode: IDBTransactionMode,
  op: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = op(tx.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("idb op failed"));
      }),
  );
}

/** 存模型 zip；key = avatar id。 */
export async function putBlob(key: string, blob: Blob): Promise<void> {
  if (!hasIdb()) return;
  await run("readwrite", (s) => s.put(blob, key));
}

export async function getBlob(key: string): Promise<Blob | null> {
  if (!hasIdb()) return null;
  try {
    const v = await run<Blob | undefined>("readonly", (s) => s.get(key));
    return v ?? null;
  } catch {
    return null;
  }
}

export async function deleteBlob(key: string): Promise<void> {
  if (!hasIdb()) return;
  try {
    await run("readwrite", (s) => s.delete(key));
  } catch {
    // 清理失败无妨：孤儿 blob 只占磁盘，不影响逻辑
  }
}

/** Wait for transaction completion so a failed model import cannot partially commit. */
export async function allBlobs(): Promise<Record<string, Blob>> {
  if (!hasIdb()) return {};
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const result: Record<string, Blob> = {};
    const cursor = tx.objectStore(STORE).openCursor();
    cursor.onsuccess = () => {
      const row = cursor.result;
      if (row) { result[String(row.key)] = row.value as Blob; row.continue(); }
    };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
export async function replaceBlobs(blobs: Record<string, Blob>): Promise<void> {
  if (!hasIdb()) throw new Error('Model storage unavailable');
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    store.clear();
    for (const [key, value] of Object.entries(blobs)) store.put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
