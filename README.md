# cmux-git-review

**[English](#english)** · **[Türkçe](#türkçe)**

<p>
  <img src="docs/uncommitted.png" alt="Uncommitted changes" width="32%">
  <img src="docs/compare.png" alt="Compare with branch" width="32%">
  <img src="docs/history.png" alt="History" width="32%">
</p>

---

## English

A git review panel for the right sidebar (**Dock**) of [cmux](https://cmux.com): uncommitted changes, commit history and branch comparison, with file-level stage / unstage / discard.

### How it works

cmux's custom sidebars cannot read files or run commands, so they cannot reach git directly. Here a small local Node server runs git, and the panel opens in the Dock as a browser tab without an address bar.

```
cmux terminal ── cmux-review open ──► local server (127.0.0.1:47391) ──► git
                                             ▲
cmux Dock ── browser tab ────────────────────┘
```

### Requirements

- macOS + cmux 0.65 or later (Dock and `--placement dock` support)
- Node.js 20+ and pnpm
- git

### Installation

```sh
git clone https://github.com/baransomakli/cmux-git-review-extension.git
cd cmux-git-review-extension
pnpm install && pnpm build
ln -sf "$PWD/dist/cli.js" ~/.local/bin/cmux-review   # ~/.local/bin must be on PATH
```

### Usage

From a cmux terminal inside a repository:

```sh
cmux-review open              # opens the panel for this repo in the Dock (starts the server if needed)
cmux-review open ../other-repo
```

The panel is a single tab in the window's Dock. Running `open` from another workspace (or for another repo) does not add a new tab; the existing tab switches to that repo.

| Mode | Shows |
|---|---|
| Uncommitted changes | Every change against `HEAD` (staged, unstaged and untracked). File headers carry a STAGED / PARTIAL / NEW tag. |
| History | The commit list (more loads as you scroll) and the diff of the selected commit. Merge commits are shown against their first parent. |
| Compare with branch | The `<branch>...HEAD` diff, for reviewing before a PR. Defaults to `origin/HEAD`, otherwise `main` / `master`. |

- File card icons: **stage/unstage**, **discard** (click twice to confirm), **open in cmux**.
- Clicking a hunk header (⇕) shows 20 more lines of context for that file.
- The panel checks for changes about every 2 seconds, so it updates on its own when you save a file.
- Keyboard: `j` / `k` move between files, `x` collapses a file, `X` collapses/expands all, `r` refreshes.
- Light and dark themes follow the system setting.

#### Discard safety

- **Single-file discard:** the file's current contents are first copied to `~/.local/state/cmux-review/discarded/<repo>/<time>/`, then the file is reset to `HEAD` (new files are deleted). To undo, copy the backup back.
- **Discard all:** every change is stashed with `git stash push --include-untracked`; `git stash pop` brings it all back.

#### Panel that follows the selected workspace (optional)

`cmux-review dock-config` prints a browser control for the global `~/.config/cmux/dock.json`. That URL is not tied to a repo; it shows the folder of whichever workspace is selected. The command does not write the file itself; if you already have a `dock.json`, add the control to its `controls` array by hand. The server must be running (`cmux-review open` or `cmux-review serve`).

### Commands

```sh
cmux-review open [path]   # open the panel in the Dock
cmux-review status        # server status
cmux-review stop          # stop the server
cmux-review serve         # run the server in the foreground (development)
cmux-review url [path]    # print the panel URL
cmux-review dock-config   # print the dock.json control
```

### Security

- The server listens only on `127.0.0.1:47391` and rejects requests that arrive under any other host name.
- Every API request needs the token stored in `~/.local/state/cmux-review/server.json` (file mode 0600). The token lives only in that file, never in the repo.
- git always runs without a shell; commit/branch values from the UI are resolved to a commit first, and stage/discard only apply to files that have actually changed.
- The port and token stay fixed, so Dock tabs restored from a cmux session keep working after a restart. After a reboot, start the server once with `cmux-review open`.

### Known limitations

- No hunk- or line-level stage and discard; actions work per file.
- For a PARTIAL (partly staged) file, the button only stages the whole file.
- Diffs over 1500 lines load on demand via "Load diff"; with more than 200 untracked files, only the first 200 are shown.
- Stage and discard buttons are hidden for conflicted files.

### Development

```sh
pnpm typecheck && pnpm build && pnpm test
```

`src/` holds the server and CLI (TypeScript → `dist/`), `web/` the panel UI (esbuild → `dist/web/`).

### License

[MIT](LICENSE)

---

## Türkçe

[cmux](https://cmux.com)'un sağ panelinde (**Dock**) çalışan git review paneli: kaydedilmemiş değişiklikler, commit geçmişi ve branch karşılaştırması. Dosya bazında stage / unstage / discard da yapılabiliyor.

### Nasıl çalışır

cmux'un custom sidebar'ları dosya okuyamıyor ve komut çalıştıramıyor, bu yüzden git'e doğrudan erişemiyor. Bu araçta yerel küçük bir Node sunucusu git'i çalıştırıyor; panel de Dock'ta adres çubuğu olmayan bir browser sekmesi olarak açılıyor.

```
cmux terminali ── cmux-review open ──► yerel sunucu (127.0.0.1:47391) ──► git
                                              ▲
cmux Dock ── browser sekmesi ─────────────────┘
```

### Gereksinimler

- macOS + cmux 0.65 veya üstü (Dock ve `--placement dock` desteği)
- Node.js 20+ ve pnpm
- git

### Kurulum

```sh
git clone https://github.com/baransomakli/cmux-git-review-extension.git
cd cmux-git-review-extension
pnpm install && pnpm build
ln -sf "$PWD/dist/cli.js" ~/.local/bin/cmux-review   # ~/.local/bin PATH'te olmalı
```

### Kullanım

Bir repo içindeki cmux terminalinden:

```sh
cmux-review open              # bu repo için paneli Dock'ta açar (sunucu kapalıysa başlatır)
cmux-review open ../diger-repo
```

Panel pencerenin Dock'unda tek bir sekmedir. Başka bir workspace'ten (veya başka bir repodan) `open` çalıştırınca yeni sekme açılmaz, mevcut sekme o repoya geçer.

| Mod | Ne gösterir |
|---|---|
| Uncommitted changes | `HEAD`'e göre tüm değişiklikler (staged, unstaged ve untracked). Dosya başlığında STAGED / PARTIAL / NEW etiketi var. |
| History | Commit listesi (aşağı kaydırdıkça devamı yüklenir) ve seçilen commit'in diff'i. Merge commit'ler ilk parent'a göre gösterilir. |
| Compare with branch | `<branch>...HEAD` farkı, PR öncesi review için. Varsayılan `origin/HEAD`, yoksa `main` / `master`. |

- Dosya kartındaki ikonlar: **stage/unstage**, **discard** (iki tıkla onay), **cmux'ta aç**.
- Hunk başlığına (⇕) tıklayınca o dosyada 20 satır daha bağlam açılır.
- Panel yaklaşık 2 saniyede bir değişiklikleri kontrol eder; dosyayı kaydedince kendiliğinden güncellenir.
- Klavye: `j` / `k` dosyalar arası, `x` dosyayı daralt, `X` hepsini daralt/aç, `r` yenile.
- Açık ve koyu tema sistem ayarını takip eder.

#### Discard güvenliği

- **Tek dosya discard:** dosyanın son hali önce `~/.local/state/cmux-review/discarded/<repo>/<zaman>/` altına kopyalanır, sonra `HEAD`'e döndürülür (yeni dosyalar silinir). Geri almak için yedeği yerine kopyalamak yeterli.
- **Discard all:** tüm değişiklikler `git stash push --include-untracked` ile stash'e alınır; `git stash pop` hepsini geri getirir.

#### Seçili workspace'i takip eden panel (opsiyonel)

`cmux-review dock-config`, global `~/.config/cmux/dock.json` için bir browser kontrolü yazdırır. Bu URL belirli bir repoya bağlı değildir; o an seçili workspace'in klasörünü gösterir. Komut dosyaya kendisi yazmaz; mevcut `dock.json` varsa `controls` dizisine elle ekleyin. Sunucunun açık olması gerekir (`cmux-review open` veya `cmux-review serve`).

### Komutlar

```sh
cmux-review open [path]   # paneli Dock'ta aç
cmux-review status        # sunucu durumu
cmux-review stop          # sunucuyu durdur
cmux-review serve         # sunucuyu ön planda çalıştır (geliştirme)
cmux-review url [path]    # panel URL'sini yazdır
cmux-review dock-config   # dock.json kontrolünü yazdır
```

### Güvenlik

- Sunucu yalnızca `127.0.0.1:47391` adresini dinler; başka bir host adıyla gelen istekleri reddeder.
- Her API isteği `~/.local/state/cmux-review/server.json` içindeki token'ı ister (dosya izni 0600). Token repoda değil, yalnızca bu dosyada durur.
- git her zaman shell olmadan çalıştırılır; arayüzden gelen commit/branch değerleri önce commit'e çözümlenir, stage/discard yalnızca gerçekten değişmiş dosyalara uygulanır.
- Port ve token sabit kalır, böylece cmux oturumundan geri yüklenen Dock sekmeleri yeniden başlatmadan sonra da çalışır. Bilgisayar yeniden başlayınca sunucuyu bir kez `cmux-review open` ile açmak gerekir.

### Bilinen sınırlar

- Hunk veya satır bazında stage ve discard yok; işlemler dosya bazında.
- PARTIAL (kısmen staged) bir dosyada buton yalnızca dosyanın tamamını stage eder.
- 1500 satırı aşan diff'ler "Load diff" ile istek üzerine açılır; 200'den fazla untracked dosya varsa yalnızca ilk 200'ü gösterilir.
- Conflict'li dosyalarda stage ve discard butonları gizlenir.

### Geliştirme

```sh
pnpm typecheck && pnpm build && pnpm test
```

`src/` sunucu ve CLI (TypeScript → `dist/`), `web/` panel arayüzü (esbuild → `dist/web/`).

### Lisans

[MIT](LICENSE)
