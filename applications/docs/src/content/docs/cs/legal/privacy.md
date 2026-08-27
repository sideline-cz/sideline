---
title: Zásady ochrany osobních údajů
description: Jaké osobní údaje Sideline sbírá, proč, komu je předává a jak je nechat smazat.
draft: true
---

:::caution[Zatím nepublikováno]
Tato stránka je koncept. Než půjde ven, je potřeba doplnit tři věci — hledej `DOPLNIT` níže. Publikuje se odstraněním `draft: true` z frontmatteru.

Text neprošel právní kontrolou.
:::

Poslední aktualizace: 27. srpna 2026

## 1. Kdo jsme

Správcem tvých osobních údajů je **DOPLNIT — jméno, sídlo a IČO provozovatele hostované instance**.

Zastihneš nás přes [GitHub Discussions](https://github.com/maxa-ondrej/sideline/discussions) nebo přes odkaz **Nahlásit chybu** v uživatelském menu aplikace.

Tyto zásady platí pro hostovanou instanci na [sideline.cz](https://sideline.cz). Zdrojový kód Sideline je dostupný pod licencí MIT — **pokud si ho hostuješ sám, jsi správcem své vlastní instance** a tyto zásady se na tebe nevztahují.

## 2. Co sbíráme

**Z Discordu, když se přihlásíš.** Používáme Discord OAuth se scopy `identify`, `guilds` a `guilds.join`. Ukládáme tvoje Discord ID, username, zobrazované jméno, přezdívku na serveru a avatar.

Tvůj e-mail z Discordu **nežádáme ani neukládáme**.

`guilds.join` nám dovoluje přidat tě na Discord server týmu, když přijmeš pozvánku. K ničemu jinému ho nepoužíváme.

**Co nám řekneš o sobě.** Jméno, datum narození, pohlaví, preferovaný jazyk, číslo dresu, pozici a vlastní odhad úrovně.

Datum narození a pohlaví slouží k automatickému zařazení do správných věkových a kategoriálních skupin. O přezkoumání takového zařazení člověkem si můžeš říct.

**Co v aplikaci děláš.** Členství v týmu, skupinách a soupiskách; RSVP a docházku; počet zmeškaných RSVP; tréninkový deník včetně poznámek, které si napíšeš; splněné týdenní výzvy; achievementy; hlasy v anketách; spolujízdy a poznámky k nim; odběry kalendáře.

**Tvůj rating.** Sideline vede u každého hráče Elo rating a k němu úplnou historii všech úprav včetně toho, kdo je zadal. Slouží k vyvažování generovaných týmů.

**Výsledky z Rules Traineru.** Pokusy, skóre a odpovědi na jednotlivé otázky. Jsou navázané na tvůj účet, ne na tým — takže ti záměrně zůstávají, i když do týmu vstoupíš nebo z něj odejdeš.

**Peníze.** Příspěvky, které ti byly předepsány, zaznamenané platby, odeslané upomínky a — pokud jsi pokladník — auditní stopu výdajů, které jsi vytvořil nebo upravil.

**Přeposílání e-mailů, jen když si to tým zapne.** Pokud si tým připojí schránku, ukládáme adresu odesílatele, předmět, **celé tělo zprávy** a přílohy každého došlého e-mailu a tento obsah posíláme externímu poskytovateli AI, aby z něj vytvořil shrnutí.

Pozor: e-mail poslaný do připojené týmové schránky může obsahovat osobní údaje lidí, kteří žádný účet na Sideline nemají a s ničím z tohoto nesouhlasili. Než tuhle funkci zapneš, pořádně to zvaž.

**Technické údaje.** Session tokeny, tokeny pro odběr kalendáře, přístupové a obnovovací tokeny k Discordu a provozní telemetrii — výkonnostní trasování a hlášení chyb včetně hlášení pádů odeslaných z tvého prohlížeče.

## 3. Proč to používáme a na jakém právním základě

- **Abychom službu vůbec poskytli** — čl. 6 odst. 1 písm. b), plnění smlouvy. Účet, členství v týmu, události, RSVP, finance a napojení na Discord.
- **Abychom ji udrželi funkční a bezpečnou** — čl. 6 odst. 1 písm. f), oprávněný zájem. Telemetrie, hlášení chyb, prevence zneužití a auditní záznamy.
- **Volitelné týmové funkce** — čl. 6 odst. 1 písm. a), souhlas udělený adminem týmu. Přeposílání e-mailů a jejich shrnování pomocí AI.

## 4. Komu je předáváme

- **Discordu** — produkt na něm stojí. Členství, role, kanály, posty k událostem i soukromé zprávy jím procházejí a řídí se [zásadami ochrany osobních údajů Discordu](https://discord.com/privacy).
- **Poskytovateli AI** (**DOPLNIT — kterému, pro hostovanou instanci**) — dostává obsah e-mailů ke shrnutí, jen u týmů, které si přeposílání zapnuly.
- **Poskytovateli příchozí pošty** (**DOPLNIT — kterému, pro hostovanou instanci**) — doručuje nám e-maily tam, kde je to zapnuté.
- **Poskytovateli hostingu** — provozuje naše servery, databázi a monitoring.

Tvoje údaje neprodáváme a nepoužíváme je k reklamě.

## 5. Jak dlouho je držíme

Údaje k účtu držíme, dokud účet existuje.

Finanční záznamy a některé auditní zápisy zůstávají i po smazání účtu, protože finanční historie musí zůstat nedotčená. Kde to zákon dovolí, raději anonymizujeme než mažeme.

**Těla e-mailů a přílohy se zatím drží bez omezení.** Automatické mazání zatím neexistuje. Než bude, řekni si adminovi týmu — nebo nám — o smazání konkrétních zpráv.

## 6. Tvoje práva

Podle GDPR nás můžeš požádat o kopii svých údajů, o jejich opravu nebo výmaz, o omezení či námitku proti zpracování, o předání v přenositelném formátu, nebo můžeš odvolat souhlas, který jsi dal.

Můžeš si taky stěžovat u [Úřadu pro ochranu osobních údajů](https://uoou.gov.cz).

**Jak práva uplatnit:** ozvi se kanály z bodu 1. Odpovíme do jednoho měsíce. Tlačítko na export ani smazání zatím v aplikaci není — tyhle žádosti vyřizuje člověk.

Admin týmu tě může z týmu odebrat, čímž se smažou tvoje data vázaná na tým. Smazání účtu na Discordu **nesmaže** automaticky tvůj účet na Sideline.

## 7. Cookies a local storage

Používáme jen nezbytné úložiště: session token, aby ses nemusel pořád přihlašovat, a local storage pro jazyk, motiv a nastavení postranního panelu.

Žádné reklamní ani analytické cookies, žádné sledování třetími stranami.

Náš vlastní monitoring chyb a výkonu běží zčásti v tvém prohlížeči. Zaznamenává časy načtení stránek a hlášení pádů — ne obsah toho, co píšeš.

## 8. Děti

Sideline je pro sportovní týmy, ve kterých bývají i nezletilí. Pokud je ti méně než 16, musí s používáním souhlasit rodič nebo zákonný zástupce.

**Za získání tohoto souhlasu odpovídá admin týmu**, ještě než nezletilého do týmu přidá.

## 9. Změny

Změny zveřejníme tady a upravíme datum nahoře. Na cokoli podstatného upozorníme i v aplikaci.
