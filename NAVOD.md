# Návod k Backlink Checkeru

Tento návod vás prevedie inštaláciou od nuly. Predpokladáme, že máte pripravený Apify API token.

## Krok 1. Vytvorenie zošita

1. Otvorte Google Sheets a vytvorte nový prázdny zošit.
2. Choďte do Súbor > Import > Nahrať.
3. Vyberte súbor `Backlink_SEO_Checker_v2.xlsx` z tohto repozitára.
4. Pri možnosti importu zvoľte **Vložiť nové hárky**.
5. Skontrolujte, že vznikli tieto listy s presným názvom: **High Quality**, **Low Quality**, **Celkový prehľad** a **Pokyny**.

## Krok 2. Vloženie skriptu

1. V zošite choďte do Rozšírenia > Apps Script.
2. Zmažte obsah predvoleného súboru `Code.gs`.
3. Skopírujte celý obsah súboru `Backlink_Checker.gs` z tohto repozitára a vložte ho do editora.
4. Uložte projekt (ikona diskety alebo Ctrl+S). Projekt si môžete premazať napríklad na "Backlink Checker".

## Krok 3. Nastavenie Apify tokenu

1. Prepnite sa v prehliadači na kartu so zošitom (dialógy fungujú len tam).
2. V Apps Script spustite funkciu `setupApifyKey()` (tlačidlo Spustiť nad editorom).
3. V dialógu vložte svoj Apify API token a potvrďte.
4. Token sa uloží bezpečne do Script Properties. Zostane tam aj po zmene kódu.

Ak sa dialóg nezobrazí, použite funkciu `setApifyKeyDirectly()`: vložte token na miesto `VLOZ_SEM_SVOJ_TOKEN`, spustite ju raz a token z kódu potom znova prepíšte na `VLOZ_SEM_SVOJ_TOKEN`. Token si spravujete sami, jeho obnova je na vašej strane.

## Krok 4. Overenie pripojenia

1. Spustite funkciu `testApifyDomainScore()`.
2. Choďte do Zobraziť > Logy (prípadne Executions) a skontrolujte, že test prebehol OK a že sa vrátili skóre pre testovacie domény.

## Krok 5. Naplnenie dát

1. Do listov **High Quality** a **Low Quality** vyplňte stĺpce A až G (žltý príkladový riadok vymažte alebo prepíšte).
2. Stĺpec E vyplňte hodnotou `dofollow` alebo `nofollow` (malými písmenami).
3. Dátum v stĺpci G zadávajte vo formáte YYYY-MM-DD.
4. Do stĺpcov H až O nič nevpisujte, o tie sa stará skript.

## Krok 6. Force Run (okamžitý prvý beh)

1. Znovu načítajte kartu so zošitom.
2. V hornom menu pribudne položka **Backlink Checker**.
3. Kliknite na **Backlink Checker > Force Run (všetko teraz)**.
4. Potvrďte dialóg. Skript spustí kontrolu oboch listov aj Domain Score naraz, prebuduje Celkový prehľad a na konci zobrazí súhrn stavov.

Force Run používate kedykoľvek, keď potrebujete čerstvé výsledky okamžite, bez čakania na automatický rozvrh.

## Krok 7. Nasadenie automatiky

1. V Apps Script spustite funkciu `createTriggers()`.
2. Vytvoria sa tieto triggery:
   - High Quality: každý deň o 6:00
   - Low Quality: každý pondelok o 7:00
   - Domain Score: 1. deň v mesiaci o 5:00
3. Funkciu `createTriggers()` spúšťajte zakaždým, keď zmeníte rozvrh v kóde. Staré triggery sa najprv zmažú, takže nevzniknú duplicity.

## Čítanie výsledkov

- **Live**: odkaz je na stránke a všetko sedí.
- **Overuje sa**: odkaz pri jednej kontrole chýbal. Ak chýba aj pri ďalšej, prejde na Lost.
- **Lost**: odkaz chýbal dve kontroly po sebe. Vybavte reklamáciu alebo obnovu.
- **Error**: stránka neexistuje alebo vracia chybu. Detail je v stĺpci M (Poznámka).

Celkový prehľad sa prebuduje automaticky po každom behu. Ručne ho upravovať netreba.

## Riešenie problémov

**Menu Backlink Checker sa nezobrazuje.** Obnovte kartu so zošitom (F5). Menu sa vytvára pri otvorení zošita.

**Force Run skončil skoro.** Beh má limit 6 minút. Skript si pozíciu zapamätá a pokračuje pri ďalšom behu. Počkajte a spustite Force Run znova, alebo nechajte dopabeť automatické triggery.

**Domain Score sa nezapísal.** Skontrolujte Logy. Najčastejšie ide o vypršaný Apify token, vtedy token obnovte cez `setupApifyKey()`.

**Apify hlási príliš veľa domén.** Za jeden beh sa kontroluje maximálne 200 unikátnych domén. Zvyšok sa doplní pri ďalšom behu triggeru.
