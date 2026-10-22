/**
 * Backlink Checker pre hoplo.sk - produkčná verzia
 * Tri listy: "High Quality", "Low Quality" a "Celkový prehľad" (automatický súhrn)
 *
 * A: ID | B: Zdrojová URL | C: Cieľová URL | D: Očakávaný anchor text | E: Typ odkazu
 * F: Agentúra/zdroj | G: Dátum získania | H: Status | I: HTTP kód | J: Posledná kontrola
 * K: Dátum zmeny statusu | L: Počet zlyhaní po sebe | M: Poznámka
 * N: Domain Score (Apify) | O: Posledná kontrola Domain Score
 *
 * Pred prvým použitím spusti raz: setupApifyKey()  -> zadáš Apify token cez dialóg
 * Rýchly test Apify pripojenia: testApifyDomainScore()
 * Nasadenie automatiky: createTriggers()
 * Okamžitý ručný beh všetkého: Force Run v menu "Backlink Checker" (pridá sa automaticky)
 */

// === KONFIGURÁCIA LINK-CHECKERA ===
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

// Listy so zdrojovými dátami (High Quality + Low Quality)
const DATA_SHEETS = ['High Quality', 'Low Quality'];

// Automatický súhrnný list, ktorý sa prebuduje po každom behu
const OVERVIEW_SHEET = 'Celkový prehľad';

// =====================================================================
// === MENU + FORCE RUN (okamžitý ručný beh) ===
// =====================================================================

/**
 * Menu sa vytvorí automaticky pri každom otvorení zošita.
 * Force Run ignoruje čakacie intervaly a spustí všetky kontroly naraz.
 */
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

/**
 * Force Run: okamžitý kompletný beh všetkých kontrol.
 * Vymaže uložené pozície obnovy (resume), preskočí 30-dňovú ochranu
 * Domain Score a spustí High Quality + Low Quality + Domain Score + prehľad.
 * Po skončení zobrazí stručné súhrnné hlásenie.
 */
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

  // 1. Vyčisti resume pozície, aby sa začalo od začiatku
  clearResumeKeys();

  // 2. Kontrola odkazov
  checkHighQuality();
  checkLowQuality();

  // 3. Domain Score bez ohľadu na 30-dňový interval
  checkDomainScores(true);

  // 4. Prebuduj súhrnný list
  refreshOverview();

  // 5. Súhrn pre používateľa
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

// === VSTUPNÉ FUNKCIE PRE LINK-CHECK (volajú sa z triggerov a menu) ===
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
    const expectedType = (row[COL.TYPE - 1] || '').toString().toLowerCase();
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

function checkSingleBacklink(sourceUrl, targetUrl, expectedType, maxRetries) {
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
      const linkFound = html.indexOf(targetUrl) !== -1 ||
                         html.toLowerCase().indexOf(targetDomain.toLowerCase()) !== -1;

      if (!linkFound) {
        return { status: 'Lost', httpCode: code, note: 'Odkaz na stránke už nie je' };
      }

      const detectedType = detectLinkType(html, targetUrl);
      const typeMismatch = detectedType && expectedType && detectedType !== expectedType;

      return {
        status: 'Live',
        httpCode: code,
        note: typeMismatch ? 'Typ zmenený na ' + detectedType : '',
        detectedType: detectedType,
        typeMismatch: typeMismatch
      };

    } catch (e) {
      lastError = e.message;
      Utilities.sleep(1500 * attempt);
    }
  }

  return { status: 'Error', httpCode: 'N/A', note: 'Zlyhalo po ' + maxRetries + ' pokusoch: ' + lastError };
}

function detectLinkType(html, targetUrl) {
  try {
    const regex = new RegExp('<a\\b[^>]*href=["\'][^"\']*' + escapeRegex(targetUrl) + '[^"\']*["\'][^>]*>', 'i');
    const match = html.match(regex);
    if (!match) return null;
    return /rel=["'][^"']*nofollow/i.test(match[0]) ? 'nofollow' : 'dofollow';
  } catch (e) {
    return null;
  }
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
// === CELKOVÝ PREHĽAD (automatický súhrn Low + High Quality) ===
// =====================================================================

/**
 * Prebuduje list "Celkový prehľad" z aktuálneho obsahu oboch zdrojových listov.
 * Volá sa automaticky po každej kontrole odkazov, dá sa spustiť aj ručne z menu.
 * Starý obsah sa celý prepíše, takže prehľad je vždy aktuálny.
 */
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

  // Vymaž starý obsah a zapíš nový
  overview.clearContents();
  overview.getRange(1, 1, rows.length, header.length).setValues(rows);
  overview.getRange(1, 1, 1, header.length).setFontWeight('bold');
  overview.setFrozenRows(1);
  overview.autoResizeColumns(1, header.length);
}

// =====================================================================
// === APIFY DOMAIN SCORE (zhorex/domain-authority-checker) ===
// =====================================================================
const APIFY_ACTOR = 'zhorex~domain-authority-checker';
const APIFY_SHEETS = ['High Quality', 'Low Quality'];
const DOMAIN_SCORE_RECHECK_DAYS = 30;   // skóre sa nemení rýchlo, netreba kontrolovať častejšie
const MAX_DOMAINS_PER_APIFY_RUN = 200;  // poistka pred 6-min limitom Apps Scriptu aj Apify sync timeoutom

/**
 * Spusti RAZ ručne pred prvým použitím. Otvorí dialóg, kam zadáš Apify API token.
 * Token sa uloží bezpečne do Script Properties - nikdy nie je súčasťou textu skriptu.
 */
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

/**
 * ALTERNATÍVA bez dialógu - ak sa vám ui.prompt() nezobrazuje (zvykne sa to stať,
 * keď skript spúšťate priamo z Apps Script editora a nie je aktívna karta so Sheetom).
 * Vložte token na miesto 'VLOZ_SEM_SVOJ_TOKEN', spustite RAZ, potom môžete text kľúča
 * pokojne zmazať z riadku, token už bude bezpečne uložený v Script Properties.
 * Token si spravujete sami, jeho obnova je na vašej strane.
 */
function setApifyKeyDirectly() {
  PropertiesService.getScriptProperties().setProperty('APIFY_API_TOKEN', 'VLOZ_SEM_SVOJ_TOKEN');
  Logger.log('Token uložený.');
}

/**
 * Rýchly test - spustite ručne z editora a pozrite Logy (Zobraziť > Logy).
 * Overí, že token aj actor fungujú, na dvoch testovacích doménach.
 */
function testApifyDomainScore() {
  const token = PropertiesService.getScriptProperties().getProperty('APIFY_API_TOKEN');
  if (!token) {
    Logger.log('Chýba APIFY_API_TOKEN - spustite najprv setupApifyKey().');
    return;
  }
  try {
    const result = callApifyDomainScore(['hoplo.sk', 'google.com'], token);
    Logger.log('Apify test OK, výsledok:');
    Logger.log(JSON.stringify(result, null, 2));
  } catch (e) {
    Logger.log('Apify test ZLYHAL: ' + e.message);
  }
}

function callApifyDomainScore(domains, token) {
  const url = 'https://api.apify.com/v2/acts/' + APIFY_ACTOR +
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
    throw new Error('Apify vrátilo HTTP ' + code + ': ' + response.getContentText().substring(0, 300));
  }
  return JSON.parse(response.getContentText());
}

/**
 * Hlavná funkcia - skontroluje Domain Score pre unikátne zdrojové domény
 * z oboch listov naraz (šetrí volania) a zapíše ho do stĺpca N + dátum do O.
 * Preskočí domény, ktoré boli kontrolované v posledných DOMAIN_SCORE_RECHECK_DAYS dňoch.
 * Parameter force=true preskočí túto ochranu (používa ho Force Run).
 */
function checkDomainScores(force) {
  const token = PropertiesService.getScriptProperties().getProperty('APIFY_API_TOKEN');
  if (!token) {
    Logger.log('Chýba APIFY_API_TOKEN - spustite najprv setupApifyKey().');
    return;
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheets = APIFY_SHEETS.map(name => ss.getSheetByName(name)).filter(s => s);
  if (sheets.length === 0) {
    Logger.log('Nenašiel som listy High Quality / Low Quality.');
    return;
  }

  const domainToRows = {};
  const now = new Date();

  sheets.forEach(sheet => {
    const lastRow = sheet.getLastRow();
    if (lastRow < START_ROW) return;
    const numRows = lastRow - START_ROW + 1;
    const data = sheet.getRange(START_ROW, 1, numRows, COL.DOMAIN_SCORE_CHECKED).getValues();

    data.forEach((row, i) => {
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
      ', kontrolujem len prvých ' + MAX_DOMAINS_PER_APIFY_RUN + '. Zvyšok sa doplní pri ďalšom behu.');
    uniqueDomains = uniqueDomains.slice(0, MAX_DOMAINS_PER_APIFY_RUN);
  }

  let results;
  try {
    results = callApifyDomainScore(uniqueDomains, token);
  } catch (e) {
    Logger.log('Apify volanie zlyhalo, skúsim nabudúce: ' + e.message);
    return;
  }

  const scoreByDomain = {};
  (results || []).forEach(item => {
    if (item && item.domain) scoreByDomain[item.domain] = item;
  });

  let okCount = 0;
  uniqueDomains.forEach(domain => {
    const item = scoreByDomain[domain];
    const rows = domainToRows[domain];
    rows.forEach(ref => {
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
  refreshOverview();
}

// =====================================================================
// === TRIGGERY (spustite createTriggers() RAZ pre plné nasadenie) ===
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
