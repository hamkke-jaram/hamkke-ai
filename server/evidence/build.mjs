// Build and verify the versioned SQLite corpus offline using the downloaded text snapshots.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const target = new URL('./care-2026-11-21.sqlite', import.meta.url);
const columns = ['id','topic','minAge','maxAge','title','publisher','url','section','keywords','passage','action','reason'];

function plainText(value, max, field) {
  assert.ok(typeof value === 'string' && value.trim().length > 0 && value.length <= max, `Invalid ${field}`);
  return value;
}

function canonical(value) {
  const url = new URL(value);
  assert.ok(url.protocol === 'https:' && !url.username && !url.password, 'Source requires an HTTPS URL');
  url.hash = '';
  return url.href;
}

function normalized(text) {
  return text.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

function readList(url) {
  const list = JSON.parse(readFileSync(url, 'utf8'));
  assert.ok(Array.isArray(list) && list.length > 0, `Empty source list: ${url.pathname}`);
  return list;
}

function addCollection(db, collection) {
  const root = new URL(collection + '/', import.meta.url);
  const sources = new Map();
  const saveDocument = db.prepare('INSERT INTO source_document VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  for (const record of readList(new URL('sources.json', root))) {
    const {sourceKey, title, publisher, url, license, licenseUrl, asset, sha256} = record;
    for (const [key,val] of Object.entries({sourceKey, title, publisher, license, asset})) plainText(val, 700, key);
    canonical(licenseUrl);
    const file = new URL(asset, root);
    assert.ok(file.href.startsWith(root.href) && file.pathname.endsWith('.txt') && !file.search && !file.hash, 'Invalid source snapshot');
    const raw = readFileSync(file);
    assert.equal(createHash('sha256').update(raw).digest('hex'), sha256, `Changed snapshot: ${sourceKey}`);
    if (record.originalAsset) {
      const original = new URL(record.originalAsset, root);
      assert.ok(original.href.startsWith(root.href) && !original.search && !original.hash, 'Invalid original asset');
      assert.equal(createHash('sha256').update(readFileSync(original)).digest('hex'), record.originalSha256, `Changed original: ${sourceKey}`);
    }
    const body = new TextDecoder('utf-8', {fatal:true}).decode(raw);
    assert.ok(body.trim().length > 24, `Empty evidence: ${sourceKey}`);
    const acquired = record.retrievedOn ?? record.retrievedAt;
    assert.match(acquired, /^\d{4}-\d{2}-\d{2}$/);
    const acquisition = plainText(record.retrieval ?? record.description, 1200, 'acquisition details');
    saveDocument.run(sourceKey, title, publisher, canonical(url), license, licenseUrl, collection + '/' + asset, sha256, body, acquired, acquisition);
    sources.set(sourceKey, {url:canonical(url), body:normalized(body)});
  }
  const savePassage = db.prepare('INSERT INTO passage (' + columns.join(',') + ') VALUES (' + columns.map(() => '?').join(',') + ')');
  const link = db.prepare('INSERT INTO passage_provenance VALUES (?,?,?)');
  for (const row of readList(new URL('passages.json',root))) {
    const source = sources.get(row.sourceKey);
    assert.ok(source && source.url === canonical(row.url), `Unmatched source: ${row.id}`);
    assert.ok(Number.isInteger(row.minAge) && row.minAge >= 0 &&
      (row.maxAge === null || (Number.isInteger(row.maxAge) && row.maxAge >= row.minAge)), `Invalid ages: ${row.id}`);
    for (const [key,limit] of Object.entries({id:100,topic:100,title:300,publisher:300,url:1200,section:300,keywords:1500,passage:1300,action:500,reason:500,anchor:500})) {
      plainText(row[key],limit,key + ' in ' + row.id);
    }
    assert.ok(normalized(row.anchor).length >= 8 && source.body.includes(normalized(row.anchor)), `Unverified excerpt: ${row.id}`);
    savePassage.run(...columns.map(key => row[key]));
    link.run(row.id,row.sourceKey,row.anchor);
  }
}

export function populateEvidence(db) {
  db.exec('PRAGMA foreign_keys=ON; BEGIN');
  try {
    db.exec(readFileSync(new URL('./passages.sql', import.meta.url), 'utf8'));
    for (const collection of ['korean','international']) addCollection(db,collection);
    assert.ok(!db.prepare('SELECT source_key FROM source_document WHERE source_key NOT IN (SELECT source_key FROM passage_provenance) LIMIT 1').get(), 'Unused download');
    db.exec(`INSERT INTO evidence_search(rowid,keywords,passage,anchor)
      SELECT p.rowid,p.keywords,p.passage,coalesce(v.anchor,'') FROM passage p
      LEFT JOIN passage_provenance v ON v.passage_id=p.id;
      INSERT INTO evidence_search(evidence_search) VALUES ('integrity-check');`);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const temporary = new URL('./build-' + randomUUID() + '.sqlite', import.meta.url);
  try {
    const db = new DatabaseSync(temporary);
    try {
      populateEvidence(db);
      console.log(db.prepare(`SELECT (SELECT version FROM metadata) AS version, count(*) AS passages,
        count(DISTINCT substr(url,1,instr(url || '#','#')-1)) AS documents, count(DISTINCT topic) AS topics,
        (SELECT count(*) FROM source_document) AS downloaded, (SELECT count(*) FROM passage_provenance) AS anchored FROM passage`).get());
    } finally {
      db.close();
    }
    // Identical rebuilds work while a Windows worker has the active DB open.
    if (!existsSync(target) || !readFileSync(target).equals(readFileSync(temporary))) renameSync(temporary, target);
  } finally {
    rmSync(temporary, {force:true});
  }
}
