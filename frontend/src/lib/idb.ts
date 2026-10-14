// IndexedDB 极简封装：存用户导入的 Live2D 模型 zip（体积大、
// 二进制，不适合进 localStorage / backend state.json）。
// 浏览器外（测试环境）所有调用静默降级为 miss/no-op。

const DB_NAME = "momo-web";
/** momo-demo 时代的旧库名：首次打开新库时一次性迁移（见 migrateLegacy）。 */
const LEGACY_DB_NAME = "momo-demo";
const DB_VERSION = 1;
const STORE = "avatars";

const hasIdb = (): boolean => typeof indexedDB !== "undefined";

let dbPromise: Promise<IDBDatabase> | null = null;

/** 打开旧库；不存在（本次 open 是新建）时关掉并删除，返回 null。 */
function openLegacyDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let created = false;
    const req = indexedDB.open(LEGACY_DB_NAME);
    req.onupgradeneeded = () => {
      created = true;
    };
    req.onsuccess = () => {
      const db = req.result;
      if (created) {
        // 原本不存在——刚才 open 顺手建了空库，清掉不留痕
        db.close();
        indexedDB.deleteDatabase(LEGACY_DB_NAME);
        resolve(null);
      } else {
        resolve(db);
      }
    };
    req.onerror = () => resolve(null);
  });
}

/** 读旧库 avatars 全量 [key, blob]；store 缺失/失败返回 null。 */
function readAllLegacy(db: IDBDatabase): Promise<[IDBValidKey, unknown][] | null> {
  return new Promise((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE, "readonly");
    } catch {
      resolve(null);
      return;
    }
    const store = tx.objectStore(STORE);
    const keysReq = store.getAllKeys();
    const valsReq = store.getAll();
    tx.oncomplete = () =>
      resolve(keysReq.result.map((k, i) => [k, valsReq.result[i]]));
    tx.onerror = () => resolve(null);
  });
}

/**
 * 旧库（momo-demo）→ 新库一次性迁移：
 * 新库 avatars 为空且旧库存在时全量复制，完成后删除旧库。
 */
async function migrateLegacy(db: IDBDatabase): Promise<void> {
  const count = await new Promise<number>((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  if (count > 0) return;

  const legacy = await openLegacyDb();
  if (!legacy) return;
  try {
    const items = await readAllLegacy(legacy);
    if (items?.length) {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        for (const [k, v] of items) store.put(v, k);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }
    if (items) indexedDB.deleteDatabase(LEGACY_DB_NAME);
  } finally {
    legacy.close();
  }
}

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => {
      const db = req.result;
      // 迁移跑完再交付 db——首个 getBlob 就能看到搬过来的旧模型。
      migrateLegacy(db)
        .catch(() => {
          // 迁移失败无妨：旧库保留，下次启动再试
        })
        .finally(() => resolve(db));
    };
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
