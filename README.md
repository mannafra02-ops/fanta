# Asta Live Fantacalcio 2026/27 — GitHub Live

Il sito carica i giocatori da **listone.json** a ogni apertura. Rosa, prezzi, osservati, budget e formazione restano nel localStorage del singolo browser.

## Pubblicazione su GitHub Pages

1. Crea un repository GitHub vuoto.
2. Carica tutti i file di questa cartella, inclusa la cartella `.github`.
3. Apri **Settings → Pages**.
4. In **Build and deployment**, scegli **Deploy from a branch**.
5. Seleziona **main** e **/(root)**, poi salva.
6. Dopo pochi minuti GitHub mostrerà il link pubblico.

## Aggiornare i giocatori

Modifica soltanto `listone.json` su GitHub. Il sito leggerà automaticamente la nuova versione. Il workflow verifica il file e rigenera `listone-fallback.js`, usato quando il sito è offline.

Ogni giocatore conserva la struttura originale (`r`, `n`, `s`, `q`, `no`, ecc.). Aggiorna anche `meta.updatedAt` in formato ISO, per esempio `2026-09-01T16:30:00Z`.

## Limite importante

Questa versione è live rispetto a GitHub. Per importare automaticamente da Fantacalcio.it serve una fonte autorizzata e stabile (API/feed/file accessibile). Non inserire credenziali nel repository.
