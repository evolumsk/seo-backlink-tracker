# Backlink Checker pre hoplo.sk

Automatický monitor backlinks vo Google Sheets pomocou Google Apps Script.
Kontroluje, či sú spätné odkazy stále nažive, či sa nezmenil typ (dofollow/nofollow),
a dopĺňa Domain Score zdrojových domén cez Apify.

## Čo skript vie

- **Kontrola odkazov.** Stiahne zdrojovú stránku, overí prítomnosť odkazu na hoplo.sk a zistí HTTP kód.
- **Detekcia typu.** Porovná skutočný typ odkazu (dofollow/nofollow) s očakávaným typom v stĺpci E.
- **Ochrana pred falošným Lost.** Odkaz sa označí ako Lost až po dvoch po sebe idúcich zlyhaniach. Predtým má status Overuje sa.
- **Obnovenie po výpadku.** Ak beh zasiahne 5-minútový limit, skript si zapamätá riadok a nabudúce pokračuje tam, kde skončil.
- **Domain Score.** Technické SEO skóre 0 až 100 zdrojovej domény cez Apify actor `zhorex/domain-authority-checker`. Kontroluje sa cca raz mesačne, pričom sa spájajú unikátne domény z oboch listov do jedného volania.
- **Celkový prehľad.** Súhrnný list sa po každom behu automaticky prebuduje z oboch zdrojových listov (Low Quality aj High Quality).
- **Force Run.** Položka v menu, ktorá okamžite spustí všetky kontroly naraz a preskočí čakacie intervaly.
- **Emailový súhrn.** Voliteľné. Vyplňte NOTIFY_EMAIL v konfigurácii a skript pošle zoznam stratených odkazov a zmien typu.

## Štruktúra hárkov

| List | Popis |
|---|---|
| High Quality | Kvalitné zdroje (blogy, magazíny). Kontrola denne o 6:00. |
| Low Quality | Adresáre a katalógy. Kontrola každý pondelok o 7:00. |
| Celkový prehľad | Automatický súhrn oboch listov. Nepíšte doň ručne. |

Stĺpce A až G vypĺňate manuálne. Stĺpce H až O píše skript.

| Stĺpec | Obsah |
|---|---|
| A | ID (manuálne) |
| B | Zdrojová URL, kde je odkaz publikovaný (manuálne) |
| C | Cieľová URL na hoplo.sk (manuálne) |
| D | Očakávaný anchor text (manuálne) |
| E | Typ odkazu, dofollow alebo nofollow (manuálne) |
| F | Agentúra alebo zdroj (manuálne) |
| G | Dátum získania, formát YYYY-MM-DD (manuálne) |
| H | Status: Live, Lost, Overuje sa, Error (automaticky) |
| I | HTTP kód zdrojovej stránky (automaticky) |
| J | Posledná kontrola (automaticky) |
| K | Dátum zmeny statusu (automaticky) |
| L | Počet zlyhaní po sebe (automaticky) |
| M | Poznámka, dôvod chyby alebo zmena typu (automaticky) |
| N | Domain Score 0 až 100 (automaticky, Apify) |
| O | Dátum kontroly Domain Score (automaticky) |

## Inštalácia

1. Vytvorte nový Google Sheet a importujte šablónu `Backlink_SEO_Checker_v2.xlsx` (Súbor > Import > Vložiť nové hárky).
2. Vymažte žltý príkladový riadok alebo ho prepíšte vlastnými dátami.
3. Otvorte Rozšírenia > Apps Script a skopírujte obsah súboru `Backlink_Checker.gs`.
4. Uložte projekt (Ctrl+S).
5. Nastavte Apify token (pozri nižšie).
6. Spustite `testApifyDomainScore()` a pozrite Logy.
7. Spustite `createTriggers()` pre automatický beh.

## Apify token

Token si spravujete sami. Jeho obnova je na vašej strane a skript ho potrebuje mať uložený v Script Properties.

Odporúčaný postup je funkcia `setupApifyKey()`, ktorá otvorí dialóg na zadanie tokenu. Alternatívne použite `setApifyKeyDirectly()`, kde token vložíte priamo do kódu, spustíte raz a text tokenu potom z kódu odstránite.

**Token nikdy necommitujte do GitHubu.** Skript ho drží v Script Properties, nie v kóde.

## Force Run

Po inštalácii sa v zošite automaticky zobrazí menu **Backlink Checker**. Položka **Force Run (všetko teraz)**:

1. Vymaže uložené pozície obnovy, aby sa začalo od prvého riadku.
2. Spustí kontrolu High Quality aj Low Quality.
3. Spustí Domain Score bez ohľadu na 30-dňový interval.
4. Prebuduje Celkový prehľad.
5. Zobrazí súhrn (Live, Lost, Overuje sa, Error).

Pozor na limit Google Apps Scriptu: jeden beh má maximálne 6 minút. Pri veľkom počte odkazov sa beh rozdelí a doplní pri ďalšom spustení.

## Automatický rozvrh

| Úloha | Frekvencia |
|---|---|
| checkHighQuality | Denne o 6:00 |
| checkLowQuality | Každý pondelok o 7:00 |
| checkDomainScores | 1. deň v mesiaci o 5:00 |

Triggery sa vytvoria funkciou `createTriggers()`. Zopakované spustenie najprv zmaže staré triggery, takže nevzniknú duplicity.

## Súbory v repozitári

- `Backlink_Checker.gs` - kompletný zdrojový kód pre Google Apps Script.
- `Backlink_SEO_Checker_v2.xlsx` - šablóna zošita s listami High Quality, Low Quality a Celkový prehľad.
- `NAVOD.md` - podrobný slovenský návod krok za krokom.

## Limity a poznámky

- Jeden beh Apps Scriptu trvá maximálne 6 minút. Skript si pamätá pozíciu a pokračuje nabudúce.
- Apify volanie je obmedzené na 200 unikátnych domín za beh. Zvyšok sa doplní pri ďalšom behu.
- Kontrola odkazu čaká 400 až 700 ms medzi požiadavkami, aby sa zdrojové stránky nepreťažovali.
- HTTP 429 a 503 sa niekoľkokrát zopakuje s čakaním, ostatné chyby sa zaznamenajú do poznámky.
