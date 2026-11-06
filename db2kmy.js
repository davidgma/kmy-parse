#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { XMLBuilder } from 'fast-xml-parser';

// 1. Parse optional command line arguments: --folder, --inputDb, --outputKmy
let folderArg = 'data';
let inputDbArg = 'output.sqlite';
let outputKmyArg = 'output.xml';

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--folder' && i + 1 < args.length) {
    folderArg = args[++i];
  } else if (arg === '--inputDb' && i + 1 < args.length) {
    inputDbArg = args[++i];
  } else if (arg === '--outputKmy' && i + 1 < args.length) {
    outputKmyArg = args[++i];
  } else if (!arg.startsWith('--') && i === 0) {
    folderArg = arg;
  }
}

const folderPath = path.isAbsolute(folderArg)
  ? folderArg
  : path.join(process.cwd(), folderArg);

// Check if folder exists
if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
  console.error(`Folder "${folderArg}" does not exist.`);
  process.exit(1);
}

// Determine input SQLite database path
let sqlitePath = path.isAbsolute(inputDbArg)
  ? inputDbArg
  : path.join(folderPath, inputDbArg);

if (!fs.existsSync(sqlitePath)) {
  // If explicitly provided name not found, search for any .sqlite file in folderPath
  const files = fs.readdirSync(folderPath);
  const found = files.find(f => f.endsWith('.sqlite'));
  if (found) {
    sqlitePath = path.join(folderPath, found);
  } else {
    console.error(`SQLite database file "${inputDbArg}" does not exist in folder "${folderArg}".`);
    process.exit(1);
  }
}

// Determine output XML file path
const outputXmlPath = path.isAbsolute(outputKmyArg)
  ? outputKmyArg
  : path.join(folderPath, outputKmyArg);

// 2. Load SQLite database into WASM memory
const sqlite3 = await sqlite3InitModule();
const buffer = fs.readFileSync(sqlitePath);
const pBuf = sqlite3.wasm.alloc(buffer.length);
sqlite3.wasm.heap8u().set(buffer, pBuf);

const db = new sqlite3.oo1.DB();
const SQLITE_DESERIALIZE_FREEONCLOSE = 1;
const SQLITE_DESERIALIZE_RESIZEABLE = 2;
const rc = sqlite3.capi.sqlite3_deserialize(
  db.pointer, 'main', pBuf, buffer.length, buffer.length,
  SQLITE_DESERIALIZE_FREEONCLOSE | SQLITE_DESERIALIZE_RESIZEABLE
);

if (rc !== 0) {
  console.error(`Failed to deserialize SQLite database, rc = ${rc}`);
  process.exit(1);
}

function isNumeric(val) {
  if (typeof val === 'number') return !isNaN(val);
  if (typeof val !== 'string') return false;
  val = val.trim();
  if (val === '') return false;
  return /^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(val);
}

// Ratio converter helper
function formatToRatio(val, maxDecimals = 2) {
  if (val === null || val === undefined || val === '') return '';
  val = String(val).trim();
  if (val === '') return '';

  if (/^([+-]?\d+)\/([+-]?\d+)$/.test(val)) {
    return val;
  }

  if (!isNumeric(val)) return val;

  const num = parseFloat(val);

  const roundedStr = num.toFixed(maxDecimals);
  const parsedFloat = parseFloat(roundedStr);

  const str = parsedFloat.toString();

  const decIndex = str.indexOf('.');
  let decimals = 0;
  if (decIndex !== -1) {
    decimals = str.length - decIndex - 1;
  }

  const denominator = Math.pow(10, decimals);
  const numerator = Math.round(parsedFloat * denominator);

  return `${numerator}/${denominator}`;
}

function queryAll(db, tableName) {
  let rows = [];
  try {
    db.exec({
      sql: `SELECT * FROM ${tableName};`,
      rowMode: 'object',
      callback: (r) => rows.push(r)
    });
  } catch (e) {
    // Return empty array if table doesn't exist
  }
  return rows;
}

// Helper to group rows by key for O(1) linear lookups
function groupBy(rows, keyField) {
  const map = new Map();
  for (const r of rows) {
    const k = r[keyField] || '';
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return map;
}

function buildFileInfo(db) {
  const rows = queryAll(db, 't_file_info');
  if (rows.length === 0) return null;

  const children = [];
  for (const r of rows) {
    const tagName = (r.setting_name || '').toUpperCase();
    const val = r.setting || '';
    let attrs = {};
    if (tagName === 'CREATION_DATE' || tagName === 'LAST_MODIFIED_DATE') {
      attrs = { date: val };
    } else if (tagName === 'VERSION' || tagName === 'FIXVERSION' || tagName === 'APPVERSION') {
      attrs = { id: val };
    } else {
      attrs = { value: val };
    }
    children.push({
      [tagName]: [],
      ':@': attrs
    });
  }

  return {
    FILEINFO: children
  };
}

function buildUser(db) {
  const rows = queryAll(db, 't_user');
  if (rows.length === 0) return null;
  const r = rows[0];

  return {
    USER: [
      {
        ADDRESS: [],
        ':@': {
          street: r.street || '',
          city: r.city || '',
          state: r.state || '',
          zip: r.zip || '',
          telephone: r.telephone || '',
          country: r.country || '',
          county: r.county || '',
          zipcode: r.zipcode || '',
          postcode: r.postcode || ''
        }
      }
    ],
    ':@': {
      name: r.name || '',
      email: r.email || ''
    }
  };
}

function buildInstitutions(db) {
  const instRows = queryAll(db, 't_institutions');
  const accInstRows = queryAll(db, 't_accounts_per_institution');

  if (instRows.length === 0) return null;

  const accInstMap = groupBy(accInstRows, 'institution_id');

  const instChildren = [];
  for (const inst of instRows) {
    const children = [];

    children.push({
      ADDRESS: [],
      ':@': {
        street: inst.street || '',
        city: inst.city || '',
        state: inst.state || '',
        zip: inst.zip || '',
        telephone: inst.telephone || '',
        country: inst.country || '',
        county: inst.county || '',
        zipcode: inst.zipcode || '',
        postcode: inst.postcode || ''
      }
    });

    const accIds = accInstMap.get(inst.id) || [];
    if (accIds.length > 0) {
      const accIdChildren = accIds.map(a => ({
        ACCOUNTID: [],
        ':@': { id: a.account_id || '' }
      }));
      children.push({
        ACCOUNTIDS: accIdChildren
      });
    }

    instChildren.push({
      INSTITUTION: children,
      ':@': {
        id: inst.id || '',
        name: inst.name || '',
        manager: inst.manager || '',
        sortcode: inst.sortcode || ''
      }
    });
  }

  return {
    INSTITUTIONS: instChildren
  };
}

function buildPayees(db) {
  const rows = queryAll(db, 't_payees');
  if (rows.length === 0) return null;

  const payeeChildren = [];
  for (const p of rows) {
    payeeChildren.push({
      PAYEE: [
        {
          ADDRESS: [],
          ':@': {
            street: p.street || '',
            city: p.city || '',
            state: '',
            zip: p.zip || '',
            telephone: p.telephone || '',
            country: p.country || '',
            county: '',
            zipcode: p.zipcode || '',
            postcode: p.postcode || ''
          }
        }
      ],
      ':@': {
        id: p.id || '',
        name: p.name || '',
        reference: p.reference || '',
        email: p.email || '',
        matchingenabled: p.matching_enabled !== undefined ? String(p.matching_enabled) : ''
      }
    });
  }

  return {
    PAYEES: payeeChildren
  };
}

function buildAccounts(db) {
  const accRows = queryAll(db, 't_accounts');
  const subRows = queryAll(db, 't_subaccount_per_account');
  const kvRows = queryAll(db, 't_account_key_value_pairs');

  if (accRows.length === 0) return null;

  const subMap = groupBy(subRows, 'parent_id');
  const kvMap = groupBy(kvRows, 'account_id');

  const accChildren = [];
  for (const acc of accRows) {
    const children = [];

    const subs = subMap.get(acc.id) || [];
    if (subs.length > 0) {
      children.push({
        SUBACCOUNTS: subs.map(s => ({
          SUBACCOUNT: [],
          ':@': { id: s.child_id || '' }
        }))
      });
    }

    const kvs = kvMap.get(acc.id) || [];
    if (kvs.length > 0) {
      children.push({
        KEYVALUEPAIRS: kvs.map(kv => ({
          PAIR: [],
          ':@': {
            key: kv.key || '',
            value: formatToRatio(kv.value, 2)
          }
        }))
      });
    }

    accChildren.push({
      ACCOUNT: children,
      ':@': {
        id: acc.id || '',
        parentaccount: acc.parentaccount || '',
        lastreconciled: acc.lastreconciled || '',
        lastmodified: acc.lastmodified || '',
        institution: acc.institution || '',
        opened: acc.opened || '',
        number: acc.number || '',
        type: acc.type !== undefined ? String(acc.type) : '',
        name: acc.name || '',
        description: acc.description || '',
        currency: acc.currency || ''
      }
    });
  }

  return {
    ACCOUNTS: accChildren
  };
}

function buildTransactions(db) {
  const txRows = queryAll(db, 't_transactions');
  const splitRows = queryAll(db, 't_splits');

  if (txRows.length === 0) return null;

  const splitMap = groupBy(splitRows, 'transaction_id');

  const txChildren = [];
  for (const tx of txRows) {
    const splits = splitMap.get(tx.id) || [];
    const splitChildren = splits.map(s => ({
      SPLIT: [],
      ':@': {
        id: s.split_id || s.id || '',
        payee: s.payee || '',
        reconciledate: s.reconciledate || '',
        action: s.action || '',
        reconcileflag: s.reconcileflag !== undefined ? String(s.reconcileflag) : '',
        value: formatToRatio(s.value, 2),
        shares: formatToRatio(s.shares, 2),
        price: formatToRatio(s.price, 8),
        memo: s.memo || '',
        account: s.account || '',
        number: s.number || '',
        bankid: s.bankid || ''
      }
    }));

    txChildren.push({
      TRANSACTION: [
        {
          SPLITS: splitChildren
        }
      ],
      ':@': {
        id: tx.id || '',
        postdate: tx.postdate || '',
        memo: tx.memo || '',
        entrydate: tx.entrydate || '',
        commodity: tx.commodity || ''
      }
    });
  }

  return {
    TRANSACTIONS: txChildren
  };
}

function buildKeyValuePairs(db) {
  const rows = queryAll(db, 't_key_value_pairs');
  if (rows.length === 0) return null;

  const pairChildren = rows.map(r => ({
    PAIR: [],
    ':@': {
      key: r.key || '',
      value: formatToRatio(r.value, 2)
    }
  }));

  return {
    KEYVALUEPAIRS: pairChildren
  };
}

function buildSecurities(db) {
  const secRows = queryAll(db, 't_securities');
  const kvRows = queryAll(db, 't_security_key_value_pairs');

  if (secRows.length === 0) return null;

  const kvMap = groupBy(kvRows, 'security_id');

  const secChildren = [];
  for (const sec of secRows) {
    const children = [];

    const kvs = kvMap.get(sec.id) || [];
    if (kvs.length > 0) {
      children.push({
        KEYVALUEPAIRS: kvs.map(kv => ({
          PAIR: [],
          ':@': {
            key: kv.key || '',
            value: formatToRatio(kv.value, 2)
          }
        }))
      });
    }

    secChildren.push({
      SECURITY: children,
      ':@': {
        id: sec.id || '',
        name: sec.name || '',
        symbol: sec.symbol || '',
        type: sec.type !== undefined ? String(sec.type) : '',
        'rounding-method': sec.rounding_method !== undefined ? String(sec.rounding_method) : '',
        saf: sec.saf !== undefined ? String(sec.saf) : '',
        pp: sec.pp !== undefined ? String(sec.pp) : '',
        'trading-currency': sec.trading_currency || '',
        'trading-market': sec.trading_market || ''
      }
    });
  }

  return {
    SECURITIES: secChildren
  };
}

function buildCurrencies(db) {
  const rows = queryAll(db, 't_currencies');
  if (rows.length === 0) return null;

  const curChildren = rows.map(c => ({
    CURRENCY: [],
    ':@': {
      id: c.id || '',
      name: c.name || '',
      symbol: c.symbol || '',
      type: c.type !== undefined ? String(c.type) : '',
      'rounding-method': c.rounding_method !== undefined ? String(c.rounding_method) : '',
      saf: c.saf !== undefined ? String(c.saf) : '',
      pp: c.pp !== undefined ? String(c.pp) : '',
      scf: c.scf !== undefined ? String(c.scf) : ''
    }
  }));

  return {
    CURRENCIES: curChildren
  };
}

function buildPrices(db) {
  const rows = queryAll(db, 't_prices');
  if (rows.length === 0) return null;

  const pairMap = new Map();
  for (const p of rows) {
    const key = `${p.price_from}||${p.price_to}`;
    if (!pairMap.has(key)) {
      pairMap.set(key, { from: p.price_from, to: p.price_to, prices: [] });
    }
    pairMap.get(key).prices.push(p);
  }

  const pairChildren = [];
  for (const [, pairObj] of pairMap) {
    const priceChildren = pairObj.prices.map(p => ({
      PRICE: [],
      ':@': {
        date: p.date || '',
        price: formatToRatio(p.price, 8),
        source: p.source || ''
      }
    }));

    pairChildren.push({
      PRICEPAIR: priceChildren,
      ':@': {
        from: pairObj.from || '',
        to: pairObj.to || ''
      }
    });
  }

  return {
    PRICES: pairChildren
  };
}

function buildReports(db) {
  const repRows = queryAll(db, 't_reports');
  const catRows = queryAll(db, 't_report_categories');
  const accRows = queryAll(db, 't_report_accounts');
  const grpRows = queryAll(db, 't_report_accountgroups');
  const dtRows = queryAll(db, 't_report_dates');

  if (repRows.length === 0) return null;

  const catMap = groupBy(catRows, 'report_id');
  const accMap = groupBy(accRows, 'report_id');
  const grpMap = groupBy(grpRows, 'report_id');
  const dtMap = groupBy(dtRows, 'report_id');

  const repChildren = [];
  for (const rep of repRows) {
    const children = [];

    const cats = catMap.get(rep.id) || [];
    for (const c of cats) {
      children.push({ CATEGORY: [], ':@': { id: c.category_id || '' } });
    }

    const accs = accMap.get(rep.id) || [];
    for (const a of accs) {
      children.push({ ACCOUNT: [], ':@': { id: a.account_id || '' } });
    }

    const grps = grpMap.get(rep.id) || [];
    for (const g of grps) {
      children.push({ ACCOUNTGROUP: [], ':@': { group: g.account_group || '' } });
    }

    const dts = dtMap.get(rep.id) || [];
    for (const d of dts) {
      children.push({ DATES: [], ':@': { from: d.from || '', to: d.to || '' } });
    }

    repChildren.push({
      REPORT: children,
      ':@': {
        id: rep.id || '',
        type: rep.type || '',
        group: rep.group || '',
        name: rep.name || '',
        comment: rep.comment || '',
        convertcurrency: rep.convertcurrency !== undefined ? String(rep.convertcurrency) : '',
        favorite: rep.favorite !== undefined ? String(rep.favorite) : '',
        skipZero: rep.skipZero !== undefined ? String(rep.skipZero) : '',
        datelock: rep.datelock || '',
        rowtype: rep.rowtype || '',
        querycolumns: rep.querycolumns || '',
        tax: rep.tax !== undefined ? String(rep.tax) : '',
        propBudgetDiff: rep.propBudgetDiff !== undefined ? String(rep.propBudgetDiff) : '',
        investments: rep.investments !== undefined ? String(rep.investments) : '',
        loans: rep.loans !== undefined ? String(rep.loans) : '',
        hidetransactions: rep.hidetransactions !== undefined ? String(rep.hidetransactions) : '',
        showcolumntotals: rep.showcolumntotals !== undefined ? String(rep.showcolumntotals) : '',
        detail: rep.detail || '',
        includestransfers: rep.includestransfers !== undefined ? String(rep.includestransfers) : ''
      }
    });
  }

  return {
    REPORTS: repChildren
  };
}

function buildBudgets(db) {
  const bRows = queryAll(db, 't_budgets');
  const baRows = queryAll(db, 't_budget_accounts');
  const pRows = queryAll(db, 't_budget_periods');

  if (bRows.length === 0) return null;

  const baMap = groupBy(baRows, 'budget_id');
  const pMap = groupBy(pRows, 'account_id');

  const bChildren = [];
  for (const b of bRows) {
    const accChildren = [];

    const bAccs = baMap.get(b.id) || [];
    for (const ba of bAccs) {
      const pChildren = [];

      const pers = pMap.get(ba.account_id) || [];
      for (const p of pers) {
        pChildren.push({
          PERIOD: [],
          ':@': {
            amount: formatToRatio(p.amount, 2),
            start: p.start || ''
          }
        });
      }

      accChildren.push({
        ACCOUNT: pChildren,
        ':@': {
          id: ba.account_id || '',
          budgetlevel: ba.budget_level || '',
          budgetsubaccounts: ba.budgetsubaccounts !== undefined ? String(ba.budgetsubaccounts) : ''
        }
      });
    }

    bChildren.push({
      BUDGET: accChildren,
      ':@': {
        id: b.id || '',
        name: b.name || '',
        start: b.start || '',
        version: b.version !== undefined ? String(b.version) : ''
      }
    });
  }

  return {
    BUDGETS: bChildren
  };
}

// 3. Build KMYMONEY-FILE XML structure
const kmyChildren = [];

const fileInfoObj = buildFileInfo(db);
if (fileInfoObj) kmyChildren.push(fileInfoObj);

const userObj = buildUser(db);
if (userObj) kmyChildren.push(userObj);

const instObj = buildInstitutions(db);
if (instObj) kmyChildren.push(instObj);

const payeesObj = buildPayees(db);
if (payeesObj) kmyChildren.push(payeesObj);

const accountsObj = buildAccounts(db);
if (accountsObj) kmyChildren.push(accountsObj);

const txObj = buildTransactions(db);
if (txObj) kmyChildren.push(txObj);

const kvObj = buildKeyValuePairs(db);
if (kvObj) kmyChildren.push(kvObj);

const secObj = buildSecurities(db);
if (secObj) kmyChildren.push(secObj);

const curObj = buildCurrencies(db);
if (curObj) kmyChildren.push(curObj);

const pricesObj = buildPrices(db);
if (pricesObj) kmyChildren.push(pricesObj);

const reportsObj = buildReports(db);
if (reportsObj) kmyChildren.push(reportsObj);

const budgetsObj = buildBudgets(db);
if (budgetsObj) kmyChildren.push(budgetsObj);

const xmlData = [
  {
    '?xml': [],
    ':@': {
      version: '1.0',
      encoding: 'utf-8'
    }
  },
  {
    'KMYMONEY-FILE': kmyChildren
  }
];

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  preserveOrder: true,
  format: true,
  indentBy: ' ',
  suppressEmptyNode: true
});

const xmlString = builder.build(xmlData);

fs.writeFileSync(outputXmlPath, xmlString, 'utf8');

db.close();
