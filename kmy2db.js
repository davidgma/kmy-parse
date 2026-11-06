#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { XMLParser } from 'fast-xml-parser';

// 1. Parse optional command line arguments: --folder, --inputXml, --outputDb
let folderArg = 'data';
let inputXmlArg = 'input.xml';
let outputDbArg = 'output.sqlite';

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--folder' && i + 1 < args.length) {
    folderArg = args[++i];
  } else if (arg === '--inputXml' && i + 1 < args.length) {
    inputXmlArg = args[++i];
  } else if (arg === '--outputDb' && i + 1 < args.length) {
    outputDbArg = args[++i];
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

// Check if input XML file exists
const inputXmlPath = path.isAbsolute(inputXmlArg)
  ? inputXmlArg
  : path.join(folderPath, inputXmlArg);

if (!fs.existsSync(inputXmlPath) || !fs.statSync(inputXmlPath).isFile()) {
  console.error(`File "${inputXmlArg}" does not exist in folder "${folderArg}".`);
  process.exit(1);
}

// 2. Setup output SQLite database path
const outputDbPath = path.isAbsolute(outputDbArg)
  ? outputDbArg
  : path.join(folderPath, outputDbArg);

if (fs.existsSync(outputDbPath)) {
  fs.unlinkSync(outputDbPath);
}

const sqlite3 = await sqlite3InitModule();
const db = new sqlite3.oo1.DB('output.sqlite', 'c');

// 3. Create all tables at the start
const createTablesSql = `
CREATE TABLE t_file_info (setting_name TEXT, setting TEXT);
CREATE TABLE t_user (name TEXT, email TEXT, street TEXT, city TEXT, state TEXT, zip TEXT, telephone TEXT, country TEXT, county TEXT, zipcode TEXT, postcode TEXT);
CREATE TABLE t_institutions (id TEXT, name TEXT, manager TEXT, sortcode TEXT, street TEXT, city TEXT, state TEXT, zip TEXT, telephone TEXT, country TEXT, county TEXT, zipcode TEXT, postcode TEXT);
CREATE TABLE t_accounts_per_institution (institution_id TEXT, account_id TEXT);
CREATE TABLE t_payees (id TEXT, name TEXT, reference TEXT, email TEXT, matching_enabled TEXT, street TEXT, city TEXT, zip TEXT, telephone TEXT, country TEXT, zipcode TEXT, postcode TEXT);
CREATE TABLE t_accounts (id TEXT, parentaccount TEXT, lastreconciled TEXT, lastmodified TEXT, institution TEXT, opened TEXT, number TEXT, type TEXT, name TEXT, description TEXT, currency TEXT, hierachy TEXT);
CREATE TABLE t_subaccount_per_account (parent_id TEXT, child_id TEXT);
CREATE TABLE t_account_key_value_pairs (account_id TEXT, key TEXT, value TEXT);
CREATE TABLE t_transactions (id TEXT, postdate TEXT, memo TEXT, entrydate TEXT, commodity TEXT);
CREATE TABLE t_splits (split_id TEXT, transaction_id TEXT, payee TEXT, reconciledate TEXT, action TEXT, reconcileflag TEXT, value TEXT, shares TEXT, price TEXT, memo TEXT, account TEXT, number TEXT, bankid TEXT);
CREATE TABLE t_key_value_pairs (key TEXT, value TEXT);
CREATE TABLE t_securities (id TEXT, name TEXT, symbol TEXT, type TEXT, rounding_method TEXT, saf TEXT, pp TEXT, trading_currency TEXT, trading_market TEXT);
CREATE TABLE t_security_key_value_pairs (security_id TEXT, key TEXT, value TEXT);
CREATE TABLE t_currencies (id TEXT, name TEXT, symbol TEXT, type TEXT, rounding_method TEXT, saf TEXT, pp TEXT, scf TEXT);
CREATE TABLE t_prices (price_from TEXT, price_to TEXT, date TEXT, price TEXT, source TEXT);
CREATE TABLE t_reports (id TEXT, type TEXT, "group" TEXT, name TEXT, comment TEXT, convertcurrency TEXT, favorite TEXT, skipZero TEXT, datelock TEXT, rowtype TEXT, querycolumns TEXT, tax TEXT, propBudgetDiff TEXT, investments TEXT, loans TEXT, hidetransactions TEXT, showcolumntotals TEXT, detail TEXT, includestransfers TEXT);
CREATE TABLE t_report_categories (report_id TEXT, category_id TEXT);
CREATE TABLE t_report_accounts (report_id TEXT, account_id TEXT);
CREATE TABLE t_report_accountgroups (report_id TEXT, account_group TEXT);
CREATE TABLE t_report_dates (report_id TEXT, "from" TEXT, "to" TEXT);
CREATE TABLE t_budgets (id TEXT, name TEXT, start TEXT, version TEXT);
CREATE TABLE t_budget_accounts (budget_id TEXT, account_id TEXT, budget_level TEXT, budgetsubaccounts TEXT);
CREATE TABLE t_budget_periods (account_id TEXT, amount TEXT, start TEXT);
`;

db.exec(createTablesSql);

// Ratio converter helper
function convertRatio(val) {
  if (val === null || val === undefined) return '';
  val = String(val).trim();
  const ratioRegex = /^([+-]?\d+)\/([+-]?\d+)$/;
  const match = val.match(ratioRegex);
  if (match) {
    const num = Number(match[1]);
    const den = Number(match[2]);
    if (den !== 0) {
      const res = num / den;
      const roundedStr = res.toFixed(8);
      return String(Number(roundedStr));
    }
  }
  return val;
}

// 4. Parse XML
const xmlContent = fs.readFileSync(inputXmlPath, 'utf8');
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  preserveOrder: true
});

const parsed = parser.parse(xmlContent);

// Helper for extracting node details in preserveOrder mode
function getNodeDetails(nodeObj) {
  let tagName = '';
  let children = [];
  let attrs = nodeObj[':@'] || {};
  let text = '';

  for (const key of Object.keys(nodeObj)) {
    if (key === ':@') continue;
    if (key === '#text') {
      text = String(nodeObj['#text']).trim();
      continue;
    }
    tagName = key;
    children = Array.isArray(nodeObj[key]) ? nodeObj[key] : [];
  }
  return { tagName, children, attrs, text };
}

const RECOGNIZED_TAGS = new Set([
  'KMYMONEY-FILE',
  'FILEINFO', 'CREATION_DATE', 'LAST_MODIFIED_DATE', 'VERSION', 'FIXVERSION', 'APPVERSION',
  'USER', 'ADDRESS',
  'INSTITUTIONS', 'INSTITUTION', 'ACCOUNTIDS', 'ACCOUNTID',
  'PAYEES', 'PAYEE',
  'ACCOUNTS', 'ACCOUNT', 'SUBACCOUNTS', 'SUBACCOUNT',
  'KEYVALUEPAIRS', 'PAIR',
  'TRANSACTIONS', 'TRANSACTION', 'SPLITS', 'SPLIT',
  'SECURITIES', 'SECURITY',
  'CURRENCIES', 'CURRENCY',
  'PRICES', 'PRICEPAIR', 'PRICE',
  'REPORTS', 'REPORT', 'CATEGORY', 'ACCOUNTGROUP', 'DATES',
  'BUDGETS', 'BUDGET', 'PERIOD'
]);

const warnedTags = new Set();

function checkUnrecognizedTag(tagName, attrs, children, text, isFileInfoChild = false) {
  if (isFileInfoChild || tagName.startsWith('?')) return;
  if (!RECOGNIZED_TAGS.has(tagName.toUpperCase())) {
    const hasAttrs = Object.keys(attrs).length > 0;
    const hasChildren = children.length > 0;
    const hasText = text.trim().length > 0;
    if (hasAttrs || hasChildren || hasText) {
      if (!warnedTags.has(tagName)) {
        warnedTags.add(tagName);
        console.warn(`Warning: Unrecognized tag "${tagName}"`);
      }
    }
  }
}

// Transaction wrapper for fast inserts
db.exec('BEGIN TRANSACTION;');

function processNodes(nodeList, parentContext = {}) {
  if (!Array.isArray(nodeList)) return;

  for (const nodeObj of nodeList) {
    const { tagName, children, attrs, text } = getNodeDetails(nodeObj);
    if (!tagName) continue;

    checkUnrecognizedTag(tagName, attrs, children, text, parentContext.isFileInfo);

    switch (tagName.toUpperCase()) {
      case 'FILEINFO': {
        for (const childNode of children) {
          const cDetails = getNodeDetails(childNode);
          if (!cDetails.tagName) continue;
          const setting_name = cDetails.tagName.toLowerCase();
          const rawVal = cDetails.attrs.date || cDetails.attrs.id || cDetails.attrs.val || cDetails.attrs.value || Object.values(cDetails.attrs)[0] || cDetails.text || '';
          const setting = convertRatio(rawVal);
          db.exec({
            sql: 'INSERT INTO t_file_info (setting_name, setting) VALUES (?, ?)',
            bind: [setting_name, setting]
          });
        }
        break;
      }

      case 'USER': {
        const name = attrs.name || '';
        const email = attrs.email || '';
        let street = '', city = '', state = '', zip = '', telephone = '', country = '', county = '', zipcode = '', postcode = '';

        for (const childNode of children) {
          const cDetails = getNodeDetails(childNode);
          if (cDetails.tagName.toUpperCase() === 'ADDRESS') {
            street = cDetails.attrs.street || '';
            city = cDetails.attrs.city || '';
            state = cDetails.attrs.state || '';
            zip = cDetails.attrs.zip || '';
            telephone = cDetails.attrs.telephone || '';
            country = cDetails.attrs.country || '';
            county = cDetails.attrs.county || '';
            zipcode = cDetails.attrs.zipcode || '';
            postcode = cDetails.attrs.postcode || '';
          }
        }

        db.exec({
          sql: 'INSERT INTO t_user (name, email, street, city, state, zip, telephone, country, county, zipcode, postcode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          bind: [name, email, street, city, state, zip, telephone, country, county, zipcode, postcode]
        });
        break;
      }

      case 'INSTITUTIONS': {
        for (const childNode of children) {
          const cDetails = getNodeDetails(childNode);
          if (cDetails.tagName.toUpperCase() === 'INSTITUTION') {
            const id = cDetails.attrs.id || '';
            const name = cDetails.attrs.name || '';
            const manager = cDetails.attrs.manager || '';
            const sortcode = cDetails.attrs.sortcode || '';
            let street = '', city = '', state = '', zip = '', telephone = '', country = '', county = '', zipcode = '', postcode = '';

            for (const instChild of cDetails.children) {
              const icDetails = getNodeDetails(instChild);
              if (icDetails.tagName.toUpperCase() === 'ADDRESS') {
                street = icDetails.attrs.street || '';
                city = icDetails.attrs.city || '';
                state = icDetails.attrs.state || '';
                zip = icDetails.attrs.zip || '';
                telephone = icDetails.attrs.telephone || '';
                country = icDetails.attrs.country || '';
                county = icDetails.attrs.county || '';
                zipcode = icDetails.attrs.zipcode || '';
                postcode = icDetails.attrs.postcode || '';
              } else if (icDetails.tagName.toUpperCase() === 'ACCOUNTIDS') {
                for (const accIdNode of icDetails.children) {
                  const aidDetails = getNodeDetails(accIdNode);
                  if (aidDetails.tagName.toUpperCase() === 'ACCOUNTID') {
                    const account_id = aidDetails.attrs.id || '';
                    db.exec({
                      sql: 'INSERT INTO t_accounts_per_institution (institution_id, account_id) VALUES (?, ?)',
                      bind: [id, account_id]
                    });
                  }
                }
              }
            }

            db.exec({
              sql: 'INSERT INTO t_institutions (id, name, manager, sortcode, street, city, state, zip, telephone, country, county, zipcode, postcode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
              bind: [id, name, manager, sortcode, street, city, state, zip, telephone, country, county, zipcode, postcode]
            });
          }
        }
        break;
      }

      case 'PAYEES': {
        for (const childNode of children) {
          const cDetails = getNodeDetails(childNode);
          if (cDetails.tagName.toUpperCase() === 'PAYEE') {
            const id = cDetails.attrs.id || '';
            const name = cDetails.attrs.name || '';
            const reference = cDetails.attrs.reference || '';
            const email = cDetails.attrs.email || '';
            const matching_enabled = cDetails.attrs.matchingenabled !== undefined ? cDetails.attrs.matchingenabled : (cDetails.attrs.matching_enabled !== undefined ? cDetails.attrs.matching_enabled : '');
            let street = '', city = '', zip = '', telephone = '', country = '', zipcode = '', postcode = '';

            for (const payeeChild of cDetails.children) {
              const pcDetails = getNodeDetails(payeeChild);
              if (pcDetails.tagName.toUpperCase() === 'ADDRESS') {
                street = pcDetails.attrs.street || '';
                city = pcDetails.attrs.city || '';
                zip = pcDetails.attrs.zip || '';
                telephone = pcDetails.attrs.telephone || '';
                country = pcDetails.attrs.country || '';
                zipcode = pcDetails.attrs.zipcode || '';
                postcode = pcDetails.attrs.postcode || '';
              }
            }

            db.exec({
              sql: 'INSERT INTO t_payees (id, name, reference, email, matching_enabled, street, city, zip, telephone, country, zipcode, postcode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
              bind: [id, name, reference, email, matching_enabled, street, city, zip, telephone, country, zipcode, postcode]
            });
          }
        }
        break;
      }

      case 'ACCOUNTS': {
        for (const childNode of children) {
          const cDetails = getNodeDetails(childNode);
          if (cDetails.tagName.toUpperCase() === 'ACCOUNT') {
            const id = cDetails.attrs.id || '';
            const parentaccount = cDetails.attrs.parentaccount || '';
            const lastreconciled = cDetails.attrs.lastreconciled || '';
            const lastmodified = cDetails.attrs.lastmodified || '';
            const institution = cDetails.attrs.institution || '';
            const opened = cDetails.attrs.opened || '';
            const number = cDetails.attrs.number || '';
            const type = cDetails.attrs.type || '';
            const name = cDetails.attrs.name || '';
            const description = cDetails.attrs.description || '';
            const currency = cDetails.attrs.currency || '';
            const hierachy = '';

            db.exec({
              sql: 'INSERT INTO t_accounts (id, parentaccount, lastreconciled, lastmodified, institution, opened, number, type, name, description, currency, hierachy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
              bind: [id, parentaccount, lastreconciled, lastmodified, institution, opened, number, type, name, description, currency, hierachy]
            });

            for (const accChild of cDetails.children) {
              const acDetails = getNodeDetails(accChild);
              if (acDetails.tagName.toUpperCase() === 'SUBACCOUNTS') {
                for (const subNode of acDetails.children) {
                  const sDetails = getNodeDetails(subNode);
                  if (sDetails.tagName.toUpperCase() === 'SUBACCOUNT') {
                    const child_id = sDetails.attrs.id || '';
                    db.exec({
                      sql: 'INSERT INTO t_subaccount_per_account (parent_id, child_id) VALUES (?, ?)',
                      bind: [id, child_id]
                    });
                  }
                }
              } else if (acDetails.tagName.toUpperCase() === 'KEYVALUEPAIRS') {
                for (const pairNode of acDetails.children) {
                  const pDetails = getNodeDetails(pairNode);
                  if (pDetails.tagName.toUpperCase() === 'PAIR') {
                    const key = pDetails.attrs.key || '';
                    const value = convertRatio(pDetails.attrs.value || '');
                    db.exec({
                      sql: 'INSERT INTO t_account_key_value_pairs (account_id, key, value) VALUES (?, ?, ?)',
                      bind: [id, key, value]
                    });
                  }
                }
              }
            }
          }
        }
        break;
      }

      case 'KEYVALUEPAIRS': {
        if (parentContext.scope !== 'ACCOUNT' && parentContext.scope !== 'SECURITY') {
          for (const pairNode of children) {
            const pDetails = getNodeDetails(pairNode);
            if (pDetails.tagName.toUpperCase() === 'PAIR') {
              const key = pDetails.attrs.key || '';
              const value = convertRatio(pDetails.attrs.value || '');
              db.exec({
                sql: 'INSERT INTO t_key_value_pairs (key, value) VALUES (?, ?)',
                bind: [key, value]
              });
            }
          }
        }
        break;
      }

      case 'TRANSACTIONS': {
        for (const childNode of children) {
          const cDetails = getNodeDetails(childNode);
          if (cDetails.tagName.toUpperCase() === 'TRANSACTION') {
            const id = cDetails.attrs.id || '';
            const postdate = cDetails.attrs.postdate || '';
            const memo = cDetails.attrs.memo || '';
            const entrydate = cDetails.attrs.entrydate || '';
            const commodity = cDetails.attrs.commodity || '';

            db.exec({
              sql: 'INSERT INTO t_transactions (id, postdate, memo, entrydate, commodity) VALUES (?, ?, ?, ?, ?)',
              bind: [id, postdate, memo, entrydate, commodity]
            });

            for (const txChild of cDetails.children) {
              const tcDetails = getNodeDetails(txChild);
              if (tcDetails.tagName.toUpperCase() === 'SPLITS') {
                for (const splitNode of tcDetails.children) {
                  const sDetails = getNodeDetails(splitNode);
                  if (sDetails.tagName.toUpperCase() === 'SPLIT') {
                    const sAttrs = sDetails.attrs;
                    const splitId = sAttrs.id || '';
                    const payee = sAttrs.payee || '';
                    const reconciledate = sAttrs.reconciledate || '';
                    const action = sAttrs.action || '';
                    const reconcileflag = sAttrs.reconcileflag || '';
                    const value = convertRatio(sAttrs.value || '');
                    const shares = convertRatio(sAttrs.shares || '');
                    const price = convertRatio(sAttrs.price || '');
                    const splitMemo = sAttrs.memo || '';
                    const account = sAttrs.account || '';
                    const number = sAttrs.number || '';
                    const bankid = sAttrs.bankid || '';

                    db.exec({
                      sql: 'INSERT INTO t_splits (split_id, transaction_id, payee, reconciledate, action, reconcileflag, value, shares, price, memo, account, number, bankid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                      bind: [splitId, id, payee, reconciledate, action, reconcileflag, value, shares, price, splitMemo, account, number, bankid]
                    });
                  }
                }
              }
            }
          }
        }
        break;
      }

      case 'SECURITIES': {
        for (const childNode of children) {
          const cDetails = getNodeDetails(childNode);
          if (cDetails.tagName.toUpperCase() === 'SECURITY') {
            const id = cDetails.attrs.id || '';
            const name = cDetails.attrs.name || '';
            const symbol = cDetails.attrs.symbol || '';
            const type = cDetails.attrs.type || '';
            const rounding_method = cDetails['rounding-method'] !== undefined ? cDetails['rounding-method'] : (cDetails.rounding_method || '');
            const saf = cDetails.attrs.saf || '';
            const pp = cDetails.attrs.pp || '';
            const trading_currency = cDetails['trading-currency'] !== undefined ? cDetails['trading-currency'] : (cDetails.trading_currency || '');
            const trading_market = cDetails['trading-market'] !== undefined ? cDetails['trading-market'] : (cDetails.trading_market || '');

            db.exec({
              sql: 'INSERT INTO t_securities (id, name, symbol, type, rounding_method, saf, pp, trading_currency, trading_market) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
              bind: [id, name, symbol, type, rounding_method, saf, pp, trading_currency, trading_market]
            });

            for (const secChild of cDetails.children) {
              const scDetails = getNodeDetails(secChild);
              if (scDetails.tagName.toUpperCase() === 'KEYVALUEPAIRS') {
                for (const pairNode of scDetails.children) {
                  const pDetails = getNodeDetails(pairNode);
                  if (pDetails.tagName.toUpperCase() === 'PAIR') {
                    const key = pDetails.attrs.key || '';
                    const value = convertRatio(pDetails.attrs.value || '');
                    db.exec({
                      sql: 'INSERT INTO t_security_key_value_pairs (security_id, key, value) VALUES (?, ?, ?)',
                      bind: [id, key, value]
                    });
                  }
                }
              }
            }
          }
        }
        break;
      }

      case 'CURRENCIES': {
        for (const childNode of children) {
          const cDetails = getNodeDetails(childNode);
          if (cDetails.tagName.toUpperCase() === 'CURRENCY') {
            const id = cDetails.attrs.id || '';
            const name = cDetails.attrs.name || '';
            const symbol = cDetails.attrs.symbol || '';
            const type = cDetails.attrs.type || '';
            const rounding_method = cDetails['rounding-method'] !== undefined ? cDetails['rounding-method'] : (cDetails.rounding_method || '');
            const saf = cDetails.attrs.saf || '';
            const pp = cDetails.attrs.pp || '';
            const scf = cDetails.attrs.scf || '';

            db.exec({
              sql: 'INSERT INTO t_currencies (id, name, symbol, type, rounding_method, saf, pp, scf) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
              bind: [id, name, symbol, type, rounding_method, saf, pp, scf]
            });
          }
        }
        break;
      }

      case 'PRICES': {
        for (const childNode of children) {
          const cDetails = getNodeDetails(childNode);
          if (cDetails.tagName.toUpperCase() === 'PRICEPAIR') {
            const price_from = cDetails.attrs.from || '';
            const price_to = cDetails.attrs.to || '';

            for (const ppChild of cDetails.children) {
              const pDetails = getNodeDetails(ppChild);
              if (pDetails.tagName.toUpperCase() === 'PRICE') {
                const date = pDetails.attrs.date || '';
                const price = convertRatio(pDetails.attrs.price || '');
                const source = pDetails.attrs.source || '';

                db.exec({
                  sql: 'INSERT INTO t_prices (price_from, price_to, date, price, source) VALUES (?, ?, ?, ?, ?)',
                  bind: [price_from, price_to, date, price, source]
                });
              }
            }
          }
        }
        break;
      }

      case 'REPORTS': {
        for (const childNode of children) {
          const cDetails = getNodeDetails(childNode);
          if (cDetails.tagName.toUpperCase() === 'REPORT') {
            const rAttrs = cDetails.attrs;
            const id = rAttrs.id || '';
            const type = rAttrs.type || '';
            const group = rAttrs.group || '';
            const name = rAttrs.name || '';
            const comment = rAttrs.comment || '';
            const convertcurrency = rAttrs.convertcurrency || '';
            const favorite = rAttrs.favorite || '';
            const skipZero = rAttrs.skipZero || '';
            const datelock = rAttrs.datelock || '';
            const rowtype = rAttrs.rowtype || '';
            const querycolumns = rAttrs.querycolumns || '';
            const tax = rAttrs.tax || '';
            const propBudgetDiff = rAttrs.propBudgetDiff || '';
            const investments = rAttrs.investments || '';
            const loans = rAttrs.loans || '';
            const hidetransactions = rAttrs.hidetransactions || '';
            const showcolumntotals = rAttrs.showcolumntotals || '';
            const detail = rAttrs.detail || '';
            const includestransfers = rAttrs.includestransfers || '';

            db.exec({
              sql: 'INSERT INTO t_reports (id, type, "group", name, comment, convertcurrency, favorite, skipZero, datelock, rowtype, querycolumns, tax, propBudgetDiff, investments, loans, hidetransactions, showcolumntotals, detail, includestransfers) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
              bind: [id, type, group, name, comment, convertcurrency, favorite, skipZero, datelock, rowtype, querycolumns, tax, propBudgetDiff, investments, loans, hidetransactions, showcolumntotals, detail, includestransfers]
            });

            for (const rChild of cDetails.children) {
              const rcDetails = getNodeDetails(rChild);
              const rcTag = rcDetails.tagName.toUpperCase();
              if (rcTag === 'CATEGORY') {
                db.exec({
                  sql: 'INSERT INTO t_report_categories (report_id, category_id) VALUES (?, ?)',
                  bind: [id, rcDetails.attrs.id || '']
                });
              } else if (rcTag === 'ACCOUNT') {
                db.exec({
                  sql: 'INSERT INTO t_report_accounts (report_id, account_id) VALUES (?, ?)',
                  bind: [id, rcDetails.attrs.id || '']
                });
              } else if (rcTag === 'ACCOUNTGROUP') {
                db.exec({
                  sql: 'INSERT INTO t_report_accountgroups (report_id, account_group) VALUES (?, ?)',
                  bind: [id, rcDetails.attrs.group || '']
                });
              } else if (rcTag === 'DATES') {
                db.exec({
                  sql: 'INSERT INTO t_report_dates (report_id, "from", "to") VALUES (?, ?, ?)',
                  bind: [id, rcDetails.attrs.from || '', rcDetails.attrs.to || '']
                });
              }
            }
          }
        }
        break;
      }

      case 'BUDGETS': {
        for (const childNode of children) {
          const cDetails = getNodeDetails(childNode);
          if (cDetails.tagName.toUpperCase() === 'BUDGET') {
            const bAttrs = cDetails.attrs;
            const id = bAttrs.id || '';
            const name = bAttrs.name || '';
            const start = bAttrs.start || '';
            const version = bAttrs.version || '';

            db.exec({
              sql: 'INSERT INTO t_budgets (id, name, start, version) VALUES (?, ?, ?, ?)',
              bind: [id, name, start, version]
            });

            for (const bChild of cDetails.children) {
              const bcDetails = getNodeDetails(bChild);
              if (bcDetails.tagName.toUpperCase() === 'ACCOUNT') {
                const account_id = bcDetails.attrs.id || '';
                const budget_level = bcDetails.attrs.budgetlevel !== undefined ? bcDetails.attrs.budgetlevel : (bcDetails.attrs.budget_level || '');
                const budgetsubaccounts = bcDetails.attrs.budgetsubaccounts || '';

                db.exec({
                  sql: 'INSERT INTO t_budget_accounts (budget_id, account_id, budget_level, budgetsubaccounts) VALUES (?, ?, ?, ?)',
                  bind: [id, account_id, budget_level, budgetsubaccounts]
                });

                for (const accChild of bcDetails.children) {
                  const acDetails = getNodeDetails(accChild);
                  if (acDetails.tagName.toUpperCase() === 'PERIOD') {
                    const amount = convertRatio(acDetails.attrs.amount || '');
                    const periodStart = acDetails.attrs.start || '';

                    db.exec({
                      sql: 'INSERT INTO t_budget_periods (account_id, amount, start) VALUES (?, ?, ?)',
                      bind: [account_id, amount, periodStart]
                    });
                  }
                }
              }
            }
          }
        }
        break;
      }

      default: {
        processNodes(children, { ...parentContext, scope: tagName.toUpperCase() });
        break;
      }
    }
  }
}

processNodes(parsed);
db.exec('COMMIT;');

// 5. Run any .sql files in alphabetical order against the sqlite database
function splitSqlStatements(sql) {
  const statements = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    const nextChar = sql[i + 1];

    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
      }
      continue;
    }
    if (inBlockComment) {
      if (char === '*' && nextChar === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote) {
      if (char === '-' && nextChar === '-') {
        inLineComment = true;
        i++;
        continue;
      }
      if (char === '/' && nextChar === '*') {
        inBlockComment = true;
        i++;
        continue;
      }
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
    } else if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
    }

    if (char === ';' && !inSingleQuote && !inDoubleQuote) {
      if (current.trim()) {
        statements.push(current.trim());
      }
      current = '';
    } else {
      current += char;
    }
  }

  if (current.trim()) {
    statements.push(current.trim());
  }

  return statements;
}

const allFiles = fs.readdirSync(folderPath);
const sqlFiles = allFiles
  .filter(f => f.endsWith('.sql') && fs.statSync(path.join(folderPath, f)).isFile())
  .sort((a, b) => a.localeCompare(b));

for (const sqlFile of sqlFiles) {
  const sqlFilePath = path.join(folderPath, sqlFile);
  const sqlContent = fs.readFileSync(sqlFilePath, 'utf8');

  let resultOutput = '';
  const statements = splitSqlStatements(sqlContent);

  for (const stmtSql of statements) {
    db.exec({
      sql: stmtSql,
      rowMode: 'array',
      callback: (row) => {
        resultOutput += row.map(v => (v === null || v === undefined ? '' : String(v))).join('|') + '\n';
      }
    });
  }

  const rootName = path.basename(sqlFile, '.sql');
  const resultFilePath = path.join(folderPath, `${rootName}.result.txt`);
  fs.writeFileSync(resultFilePath, resultOutput, 'utf8');
}

// Export database binary buffer to outputDbPath
const dbByteArray = sqlite3.capi.sqlite3_js_db_export(db);
fs.writeFileSync(outputDbPath, Buffer.from(dbByteArray));
db.close();
