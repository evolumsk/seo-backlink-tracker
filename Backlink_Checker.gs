/**
 * Backlink Checker pre hoplo.sk - verzia 3 (opravená)
 * Opravy oproti v2:
 *  1. detegovaný typ odkazu (dofollow/nofollow/sponsored/ugc + rel atribúty) sa VŽDY zapíše
 *     do stĺpca M, nielen pri rozpore so stĺpcom E
 *  2. presné hľadanie <a> tagu - žiadny fallback na "doména niekde v HTML" bez varovania;
 *     pri zhode len na doméne sa do poznámky napíše skutočný href (ochrana pred false positive)
 *  3. Domain Score: pri zlyhaní Apify volania sa chyba zapíše VISIBLE do stĺpca N (ERR: ...)
 *     a dátum sa NEzapíše, takže sa to pri ďalšom behu zopakuje
 *  4. Apify endpoint prehodný na /v2/actors/ (legacy /acts/ alias)
 *  5. rozpoznáva aj rel="sponsored" a rel="ugc", nie len nofollow
 */

const COL = {
  SOURCE_URL: 2, TARGET_URL: 3, ANCHOR: 4, TYPE: 5, AGENCY: 6, PURCHASE_DATE: 7,
  STATUS: 8, HTTP_CODE: 9, LAST_CHECK: 10, STATUS_CHANGED: 11, FAIL_COUNT: 12, NOTE: 13,
  DOMAIN_SCORE: 14, DOMAIN_SCORE_CHECKED: 15
};

const NOTIFY_EMAIL = '';
const START_ROW = 2;
const MAX_RUNTIME_MS = 5 * 60 * 1000;
const LOST_AFTER_FAILS = 2;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const DATA_SHEETS = ['High Quality', 'Low Quality'];
const OVERVIEW_SHEET = 'Celkový prehľad';

// =====================================================================
// === MENU + FORCE RUN ===
// =====================================================================

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Backlink Checker')
    .addItem('▶ Force Run (všetko teraz)', 'forceRunAll')
    .addSeparator()
    .addItem('Kontrolovať High Quality', 'checkHighQuality')
    .addItem('Kontrolovať Low Quality', 'checkLowQuality')
    .addItem('Kontrolovať Domain Score (Apify)', 'checkDomainScores')
    .addItem('Obnoviť Celkový prehľad', 'refreshOverview')
    .addSeparator()
    .addItem('1. Nastaviť Apify token', 'setupApifyKey')
    .addItem('2. Test Apify pripojenia', 'testApifyDomainScore')
    .addItem('3. Nastaviť automatické triggery', 'createTriggers')
    .addToUi();
}

function forceRunAll() {
  const ui = SpreadsheetApp.getUi();
  const confirmed = ui.alert(
    'Force Run',
    'Spustí sa okamžitá kontrola všetkých odkazov (High Quality aj Low Quality) ' +
    'vrátane Domain Score. Môže to trvať niekoľko minút. Chcete pokračovať?',
    ui.ButtonSet.YES_NO
  );
  if (confirmed !== ui.Button.YES) return;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.toast('Force Run sa spustil, kontrolujem odkazy...', 'Backlink Checker', 30);

  clearResumeKeys();
  checkHighQuality();
  checkLowQuality();
  checkDomainScores(true);
  refreshOverview();

  const summary = buildRunSummary(ss);
  ss.toast('Force Run dokončený.', 'Backlink Checker', 30);
  ui.alert('Force Run dokončený', summary, ui.ButtonSet.OK);
}

function clearResumeKeys() {
  const props = PropertiesService.getScriptProperties();
  DATA_SHEETS.forEach(function (name) {
    props.deleteProperty('resumeRow_' + name);
  });
}

function buildRunSummary(ss) {
  let live = 0, lost = 0, checking = 0, error = 0;
  DATA_SHEETS.forEach(function (name) {
    const sheet = ss.getSheetByName(name);
    if (!sheet || sheet.getLastRow() < START_ROW) return;
    const data = sheet.getRange(START_ROW, 1, sheet.getLastRow() - START_ROW + 1, COL.STATUS).getValues();
    data.forEach(function (row) {
      const s = (row[COL.STATUS - 1] || '').toString();
      if (s === 'Live') live++;
      else if (s === 'Lost') lost++;
      else if (s === 'Overuje sa') checking++;
      else if (s === 'Error') error++;
    });
  });
  return 'Live: ' + live + '   Lost: ' + lost + '   Overuje sa: ' + checking + '   Error: ' + error;
}

// === VSTUPNÉ FUNKCIE PRE LINK-CHECK ===
function checkHighQuality() {
  runSheet('High Quality', 3);
}

function checkLowQuality() {
  runSheet('Low Quality', 2);
}

function runSheet(sheetName, maxRetries) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet) {
    Logger.log('List "' + sheetName + '" neexistuje.');
    return;
  }
  processSheet(sheet, { name: sheetName, maxRetries: maxRetries }, Date.now());
}

function processSheet(sheet, cfg, startTime) {
  const props = PropertiesService.getScriptProperties();
  const resumeKey = 'resumeRow_' + cfg.name;
  const lastRow = sheet.getLastRow();
  if (lastRow < START_ROW) return;

  let startRow = Number(props.getProperty(resumeKey)) || START_ROW;
  if (startRow > lastRow) startRow = START_ROW;

  const numRows = lastRow - startRow + 1;
  const data = sheet.getRange(startRow, 1, numRows, COL.NOTE).getValues();
  const lostLinks = [];
  const typeChanges = [];

  for (let i = 0; i < data.length; i++) {
    if (Date.now() - startTime > MAX_RUNTIME_MS) {
      props.setProperty(resumeKey, String(startRow + i));
      Logger.log('Časový limit - list ' + cfg.name + ' pokračuje nabudúce od riadku ' + (startRow + i));
      sendDigest(cfg.name, lostLinks, typeChanges);
      return;
    }

    const rowIndex = startRow + i;
    const row = data[i];
    const sourceUrl = row[COL.SOURCE_URL - 1];
    const targetUrl = row[COL.TARGET_URL - 1];
    const expectedType = (row[COL.TYPE - 1] || '').toString().toLowerCase().trim();
    const prevStatus = row[COL.STATUS - 1];
    const prevFailCount = Number(row[COL.FAIL_COUNT - 1]) || 0;

    if (!sourceUrl || !targetUrl) continue;

    const result = checkSingleBacklink(sourceUrl, targetUrl, expectedType, cfg.maxRetries);

    let newStatus = result.status;
    let failCount = prevFailCount;

    if (result.status === 'Lost') {
      failCount += 1;
      if (failCount < LOST_AFTER_FAILS) newStatus = 'Overuje sa';
    } else {
      failCount = 0;
    }

    sheet.getRange(rowIndex, COL.STATUS).setValue(newStatus);
    sheet.getRange(rowIndex, COL.HTTP_CODE).setValue(result.httpCode);
    sheet.getRange(rowIndex, COL.LAST_CHECK).setValue(new Date());
    sheet.getRange(rowIndex, COL.FAIL_COUNT).setValue(failCount);
    sheet.getRange(rowIndex, COL.NOTE).setValue(result.note || '');

    if (newStatus !== prevStatus) {
      sheet.getRange(rowIndex, COL.STATUS_CHANGED).setValue(new Date());
    }
    if (newStatus === 'Lost') {
      lostLinks.push(sourceUrl + ' (riadok ' + rowIndex + ')');
    }
    if (result.typeMismatch) {
      typeChanges.push(sourceUrl + ' - očakávané "' + expectedType + '", nájdené "' + result.detectedType + '" (riadok ' + rowIndex + ')');
    }

    Utilities.sleep(400 + Math.floor(Math.random() * 300));
  }

  props.deleteProperty(resumeKey);
  sendDigest(cfg.name, lostLinks, typeChanges);
  refreshOverview();
}

// =====================================================================
// === KONTROLA JEDNOTLIVÉHO ODKAZU (opravená verzia) ===
// =====================================================================

function checkSingleBacklink(sourceUrl, targetUrl, expectedType, maxRetries) {
  sourceUrl = sanitizeUrl(sourceUrl);
  targetUrl = sanitizeUrl(targetUrl);
  const targetDomain = extractDomain(targetUrl);
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = UrlFetchApp.fetch(sourceUrl, {
        muteHttpExceptions: true,
        followRedirects: true,
        validateHttpsCertificates: false,
        headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html,application/xhtml+xml' }
      });
      const code = response.getResponseCode();

      if (code === 429 || code === 503) {
        lastError = 'HTTP ' + code + ' (rate limit/výpadok)';
        Utilities.sleep(2000 * attempt);
        continue;
      }
      if (code === 404 || code === 410) {
        return { status: 'Error', httpCode: code, note: 'Stránka neexistuje (zmazaná/presunutá)' };
      }
      if (code >= 400) {
        return { status: 'Error', httpCode: code, note: 'Stránka vracia chybu' };
      }

      const html = response.getContentText();
      const info = extractLinkInfo(html, targetUrl, targetDomain);

      if (info.found === 'no') {
        return { status: 'Lost', httpCode: code, note: 'Odkaz na stránke už nie je' };
      }

      // Typ sa vždy zapíše do poznámky (aj keď stĺpec E je prázdny)
      let note = info.type + (info.rel ? ' (rel="' + info.rel + '")' : ' (bez rel)');

      // Varovanie pri zhode len na doméne - presná cieľová URL sa nenašla
      if (info.found === 'domain') {
        note = '⚠ URL sa nezhoduje presne - na stránke je ' + info.href + ' | ' + note;
      }

      let typeMismatch = false;
      if (expectedType && info.type !== expectedType) {
        typeMismatch = true;
        note = 'ZMENA TYPU: očakávané "' + expectedType + '", je "' + info.type + '" | ' + note;
      }

      return {
        status: 'Live',
        httpCode: code,
        note: note,
        detectedType: info.type,
        typeMismatch: typeMismatch
      };

    } catch (e) {
      lastError = e.message;
      Utilities.sleep(1500 * attempt);
    }
  }

  return { status: 'Error', httpCode: 'N/A', note: 'Zlyhalo po ' + maxRetries + ' pokusoch: ' + lastError };
}

/**
 * Nájde <a> tag odkazujúci na targetUrl. Presná zhoda (po normalizácii
 * trailing lomítok a veľkých písmen) = 'exact'; zhoda len na doméne = 'domain'.
 * Vracia aj celý rel atribút, takže vidíte sponsored/ugc/nofollow kombinácie.
 */
function extractLinkInfo(html, targetUrl, targetDomain) {
  const norm = function (s) {
    return s.replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
  };
  const targetNorm = norm(targetUrl);
  const domainNorm = norm(targetDomain);

  const anchorRe = /<a\b[^>]*href=["']([^"']*)["'][^>]*>/gi;
  let m;
  let domainMatch = null;

  while ((m = anchorRe.exec(html)) !== null) {
    const href = m[1];
    const hrefNorm = norm(href);

    if (hrefNorm === targetNorm) {
      return buildInfo(m[0], href, 'exact');
    }
    // zhoda na doméne, ale iná cesta (napr. odkazuje len na homepage namiesto /kontakt)
    if (!domainMatch &&
        (hrefNorm === domainNorm || hrefNorm.indexOf(domainNorm + '/') === 0)) {
      domainMatch = buildInfo(m[0], href, 'domain');
    }
  }
  return domainMatch || { found: 'no', type: null, rel: '', href: '' };
}

function buildInfo(tag, href, found) {
  const relMatch = tag.match(/rel=["']([^"']*)["']/i);
  const rel = relMatch ? relMatch[1].toLowerCase() : '';
  let type = 'dofollow';
  if (/\bsponsored\b/.test(rel)) type = 'sponsored';
  else if (/\bnofollow\b/.test(rel)) type = 'nofollow';
  else if (/\bugc\b/.test(rel)) type = 'ugc';
  return { found: found, type: type, rel: rel, href: href };
}

function sanitizeUrl(url) {
  let u = url.toString().trim();
  u = u.replace(/[\u200B-\u200D\uFEFF]/g, '');
  u = u.replace(/\s+/g, '%20');
  return u;
}

function extractDomain(url) {
  return url.replace(/^https?:\/\//, '').split('/')[0];
}

function sendDigest(sheetName, lostLinks, typeChanges) {
  if (!NOTIFY_EMAIL || (lostLinks.length === 0 && typeChanges.length === 0)) return;
  let body = '';
  if (lostLinks.length) body += 'Stratené odkazy (' + sheetName + '):\n' + lostLinks.join('\n') + '\n\n';
  if (typeChanges.length) body += 'Zmenený typ odkazu (' + sheetName + '):\n' + typeChanges.join('\n');
  MailApp.sendEmail(NOTIFY_EMAIL, 'Backlink checker - ' + sheetName, body);
}

// =====================================================================
// === CELKOVÝ PREHĽAD ===
// =====================================================================

function refreshOverview() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let overview = ss.getSheetByName(OVERVIEW_SHEET);
  if (!overview) {
    overview = ss.insertSheet(OVERVIEW_SHEET, 0);
  }

  const header = ['List', 'ID', 'Zdrojová URL', 'Cieľová URL', 'Anchor text', 'Typ',
                  'Agentúra/zdroj', 'Dátum získania', 'Status', 'HTTP kód',
                  'Posledná kontrola', 'Domain Score'];
  const rows = [header];

  DATA_SHEETS.forEach(function (name) {
    const sheet = ss.getSheetByName(name);
    if (!sheet || sheet.getLastRow() < START_ROW) return;
    const data = sheet.getRange(START_ROW, 1, sheet.getLastRow() - START_ROW + 1, COL.DOMAIN_SCORE).getValues();
    data.forEach(function (row, i) {
      if (!row[COL.SOURCE_URL - 1]) return;
      rows.push([
        name,
        row[0],
        row[COL.SOURCE_URL - 1],
        row[COL.TARGET_URL - 1],
        row[COL.ANCHOR - 1],
        row[COL.TYPE - 1],
        row[COL.AGENCY - 1],
        row[COL.PURCHASE_DATE - 1],
        row[COL.STATUS - 1],
        row[COL.HTTP_CODE - 1],
        row[COL.LAST_CHECK - 1],
        row[COL.DOMAIN_SCORE - 1]
      ]);
    });
  });

  overview.clearContents();
  overview.getRange(1, 1, rows.length, header.length).setValues(rows);
  overview.getRange(1, 1, 1, header.length).setFontWeight('bold');
  overview.setFrozenRows(1);
  overview.autoResizeColumns(1, header.length);
}

// =====================================================================
// === APIFY DOMAIN SCORE (opravená verzia - chyby viditeľné v hárku) ===
// =====================================================================

const APIFY_ACTOR = 'zhorex~domain-authority-checker';
const APIFY_SHEETS = ['High Quality', 'Low Quality'];
const DOMAIN_SCORE_RECHECK_DAYS = 30;
const MAX_DOMAINS_PER_APIFY_RUN = 200;

function setupApifyKey() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt('Zadaj Apify API token', 'Nájdeš ho v Apify Console > Settings > Integrations.', ui.ButtonSet.OK_CANCEL);
  if (response.getSelectedButton() == ui.Button.OK) {
    const token = response.getResponseText().trim();
    if (token) {
      PropertiesService.getScriptProperties().setProperty('APIFY_API_TOKEN', token);
      ui.alert('Apify token bol uložený.');
    }
  }
}

function setApifyKeyDirectly() {
  PropertiesService.getScriptProperties().setProperty('APIFY_API_TOKEN', 'VLOZ_SEM_SVOJ_TOKEN');
  Logger.log('Token uložený.');
}

/**
 * Test - okrem logov vypíše výsledok aj do dialógu, aby ste nemuseli hľadať Logy.
 */
function testApifyDomainScore() {
  const token = PropertiesService.getScriptProperties().getProperty('APIFY_API_TOKEN');
  if (!token) {
    SpreadsheetApp.getUi().alert('Chýba APIFY_API_TOKEN - spustite najprv setupApifyKey().');
    return;
  }
  try {
    const result = callApifyDomainScore(['hoplo.sk', 'google.com'], token);
    Logger.log('Apify test OK: ' + JSON.stringify(result));
    SpreadsheetApp.getUi().alert('Apify test OK:\n' + JSON.stringify(result, null, 2));
  } catch (e) {
    Logger.log('Apify test ZLYHAL: ' + e.message);
    SpreadsheetApp.getUi().alert('Apify test ZLYHAL:\n' + e.message);
  }
}

function callApifyDomainScore(domains, token) {
  const url = 'https://api.apify.com/v2/actors/' + APIFY_ACTOR +
    '/run-sync-get-dataset-items?token=' + encodeURIComponent(token);

  const payload = { domains: domains, maxConcurrency: 10, timeout: 15 };

  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const code = response.getResponseCode();
  if (code !== 200 && code !== 201) {
    throw new Error('Apify HTTP ' + code + ': ' + response.getContentText().substring(0, 300));
  }
  return JSON.parse(response.getContentText());
}

/**
 * Hlavná funkcia - pri zlyhaní volania zapíše 'ERR: ...' do stĺpca N
 * a NEzapíše dátum do O, takže sa domény pri ďalšom behu skontrolujú znova.
 */
function checkDomainScores(force) {
  const token = PropertiesService.getScriptProperties().getProperty('APIFY_API_TOKEN');
  if (!token) {
    SpreadsheetApp.getActiveSpreadsheet().toast(
      'Domain Score preskočený - chýba APIFY_API_TOKEN. Spustite setupApifyKey().',
      'Backlink Checker', 60);
    Logger.log('Chýba APIFY_API_TOKEN - spustite najprv setupApifyKey().');
    return;
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheets = APIFY_SHEETS.map(function (name) { return ss.getSheetByName(name); }).filter(function (s) { return s; });
  if (sheets.length === 0) {
    Logger.log('Nenašiel som listy High Quality / Low Quality.');
    return;
  }

  const domainToRows = {};
  const now = new Date();

  sheets.forEach(function (sheet) {
    const lastRow = sheet.getLastRow();
    if (lastRow < START_ROW) return;
    const numRows = lastRow - START_ROW + 1;
    const data = sheet.getRange(START_ROW, 1, numRows, COL.DOMAIN_SCORE_CHECKED).getValues();

    data.forEach(function (row, i) {
      const rowIndex = START_ROW + i;
      const sourceUrl = row[COL.SOURCE_URL - 1];
      if (!sourceUrl) return;

      const lastChecked = row[COL.DOMAIN_SCORE_CHECKED - 1];
      const needsCheck = force || !lastChecked ||
        (now - new Date(lastChecked)) / (1000 * 60 * 60 * 24) >= DOMAIN_SCORE_RECHECK_DAYS;
      if (!needsCheck) return;

      const domain = extractDomain(sourceUrl);
      if (!domainToRows[domain]) domainToRows[domain] = [];
      domainToRows[domain].push({ sheet: sheet, rowIndex: rowIndex });
    });
  });

  let uniqueDomains = Object.keys(domainToRows);
  if (uniqueDomains.length === 0) {
    Logger.log('Žiadne domény nepotrebujú kontrolu Domain Score.');
    return;
  }
  if (uniqueDomains.length > MAX_DOMAINS_PER_APIFY_RUN) {
    Logger.log('Pozor: ' + uniqueDomains.length + ' domén presahuje limit ' + MAX_DOMAINS_PER_APIFY_RUN +
      ', kontrolujem len prvých ' + MAX_DOMAINS_PER_APIFY_RUN + '.');
    uniqueDomains = uniqueDomains.slice(0, MAX_DOMAINS_PER_APIFY_RUN);
  }

  let results;
  try {
    results = callApifyDomainScore(uniqueDomains, token);
  } catch (e) {
    // OPRAVA: chyba sa zapíše viditeľne do hárku namiesto tichého logu
    Logger.log('Apify volanie zlyhalo: ' + e.message);
    uniqueDomains.forEach(function (domain) {
      domainToRows[domain].forEach(function (ref) {
        ref.sheet.getRange(ref.rowIndex, COL.DOMAIN_SCORE).setValue('ERR: ' + e.message.substring(0, 180));
        // dátum do O sa NEzapíše - pri ďalšom behu sa to skúsi znova
      });
    });
    ss.toast('Domain Score zlyhal: ' + e.message, 'Backlink Checker', 60);
    return;
  }

  const scoreByDomain = {};
  (results || []).forEach(function (item) {
    if (item && item.domain) scoreByDomain[item.domain] = item;
  });

  let okCount = 0;
  uniqueDomains.forEach(function (domain) {
    const item = scoreByDomain[domain];
    const rows = domainToRows[domain];
    rows.forEach(function (ref) {
      if (item && typeof item.domainScore === 'number') {
        ref.sheet.getRange(ref.rowIndex, COL.DOMAIN_SCORE).setValue(item.domainScore);
        okCount++;
      } else {
        ref.sheet.getRange(ref.rowIndex, COL.DOMAIN_SCORE).setValue('N/A');
      }
      ref.sheet.getRange(ref.rowIndex, COL.DOMAIN_SCORE_CHECKED).setValue(new Date());
    });
  });

  Logger.log('Domain Score skontrolovaný pre ' + uniqueDomains.length + ' domén (' + okCount + ' úspešných).');
  ss.toast('Domain Score: ' + okCount + '/' + uniqueDomains.length + ' domén úspešne.', 'Backlink Checker', 30);
  refreshOverview();
}

// =====================================================================
// === TRIGGERY ===
// =====================================================================

function createTriggers() {
  deleteTriggerFor('checkHighQuality');
  deleteTriggerFor('checkLowQuality');
  deleteTriggerFor('checkDomainScores');

  ScriptApp.newTrigger('checkHighQuality').timeBased().everyDays(1).atHour(6).create();
  ScriptApp.newTrigger('checkLowQuality').timeBased().everyWeeks(1).onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(7).create();
  ScriptApp.newTrigger('checkDomainScores').timeBased().onMonthDay(1).atHour(5).create();

  Logger.log('Triggery nastavené: High Quality denne, Low Quality týždenne, Domain Score mesačne.');
}

function deleteTriggerFor(fnName) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === fnName) ScriptApp.deleteTrigger(t);
  });
}
