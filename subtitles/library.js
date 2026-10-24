/* Extension-origin IndexedDB, shared by the workspace and service worker. */
(() => {
  'use strict';
  let databasePromise;
  function open() {
    if (!databasePromise) databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open('ottspeed-subtitles', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('sessions', { keyPath: 'mediaKey' });
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => { database.close(); databasePromise = null; };
        resolve(database);
      };
      request.onerror = () => { databasePromise = null; reject(request.error); };
      request.onblocked = () => { databasePromise = null; reject(new Error('다른 OTTDeck 작업실을 닫고 다시 시도하세요.')); };
    });
    return databasePromise;
  }
  async function transaction(mode, operation) {
    const database = await open();
    return new Promise((resolve, reject) => {
      const tx = database.transaction('sessions', mode);
      let request;
      try { request = operation(tx.objectStore('sessions')); } catch (error) { reject(error); return; }
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error || request.error || new Error('자막을 저장하지 못했습니다.'));
      tx.onabort = () => reject(tx.error || new Error('자막 저장이 중단되었습니다.'));
    });
  }
  async function write(mediaKey, expectedRevision, value) {
    const database = await open();
    return new Promise((resolve, reject) => {
      const tx = database.transaction('sessions', 'readwrite');
      const store = tx.objectStore('sessions');
      const request = store.get(mediaKey);
      let committed;
      let failure;
      request.onsuccess = () => {
        const currentRevision = request.result?.revision || 0;
        if (currentRevision !== expectedRevision) {
          failure = new Error('다른 작업실에서 이 영상의 자막을 수정했습니다. 최신 저장 상태를 불러온 뒤 다시 시도하세요.');
          failure.name = 'ConflictError'; tx.abort(); return;
        }
        if (value === null) { store.delete(mediaKey); return; }
        // An opaque token also prevents stale writes after a delete/recreate cycle.
        committed = { ...value, revision: crypto.randomUUID(), updatedAt: new Date().toISOString() };
        store.put(committed);
      };
      tx.oncomplete = () => resolve(committed);
      tx.onerror = () => reject(failure || tx.error || request.error || new Error('자막을 저장하지 못했습니다.'));
      tx.onabort = () => reject(failure || tx.error || new Error('자막 저장이 중단되었습니다.'));
    });
  }
  globalThis.OTTSubtitleLibrary = Object.freeze({
    get: mediaKey => transaction('readonly', store => store.get(mediaKey)),
    list: () => transaction('readonly', store => store.getAll()),
    put: async session => {
      if (!session?.mediaKey) return Promise.reject(new Error('영상 식별자가 없습니다.'));
      const previous=await transaction('readonly',store=>store.get(session.mediaKey));
      const candidate=await OTTSubtitleCatalog.prepareWrite(previous,session);
      return write(session.mediaKey, session.revision || 0, candidate);
    },
    restore: async sessions => {
      if(!Array.isArray(sessions)||sessions.length>500||new Set(sessions.map(s=>s.mediaKey)).size!==sessions.length)throw new Error('복원할 회차 목록이 올바르지 않습니다.');
      const clean=await Promise.all(sessions.map(OTTSubtitleCatalog.cleanSession));
      const database=await open();
      return new Promise((resolve,reject)=>{
        const tx=database.transaction('sessions','readwrite'),store=tx.objectStore('sessions');let inserted=0,skipped=0;
        for(const session of clean){const request=store.get(session.mediaKey);request.onsuccess=()=>{
          if(request.result){skipped++;return;}
          store.put({...session,revision:crypto.randomUUID(),updatedAt:new Date().toISOString()});inserted++;
        };}
        tx.oncomplete=()=>resolve({inserted,skipped});tx.onerror=()=>reject(tx.error||new Error('백업 복원에 실패했습니다.'));tx.onabort=()=>reject(tx.error||new Error('백업 복원이 중단됐습니다.'));
      });
    },
    remove: (mediaKey, revision = 0) => write(mediaKey, revision, null)
  });
})();
