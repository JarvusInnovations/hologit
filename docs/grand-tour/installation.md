# Grand Tour: Installation

Hologit can be installed via [habitat](https://www.habitat.sh/) (best option in Linux environments):

```console
$ hab pkg install -b jarvus/hologit
» Installing jarvus/hologit
☁ Determining latest version of jarvus/hologit in the 'stable' channel
→ Using jarvus/hologit/0.4.1/20181224022822
★ Install of jarvus/hologit/0.4.1/20181224022822 complete with 0 new packages installed.
» Binlinking git-holo from jarvus/hologit/0.4.1/20181224022822 into /bin
★ Binlinked git-holo from jarvus/hologit/0.4.1/20181224022822 to /bin/git-holo
```

or with [npm](https://www.npmjs.com/) (best option in Mac environments):

```console
$ git --version # ensure >= 2.8.0
git version 2.17.2 (Apple Git-113)
$ node --version # ensure >= 8.3.0
v11.5.0
$ npm install -g hologit
/usr/local/bin/git-holo -> /usr/local/lib/node_modules/hologit/bin/cli.js
+ hologit@0.4.1
updated 1 package in 1.947s
```

## Optional: watchman for working trees

Install `watchman` to enable watching working trees via [habitat](https://www.habitat.sh/) (best option in Linux environments):

```console
$ hab pkg install -b jarvus/watchman
» Installing jarvus/watchman
☁ Determining latest version of jarvus/watchman in the 'stable' channel
→ Using jarvus/watchman/4.9.0/20180624025538
★ Install of jarvus/watchman/4.9.0/20180624025538 complete with 0 new packages installed.
» Binlinking watchman from jarvus/watchman/4.9.0/20180624025538 into /bin
★ Binlinked watchman from jarvus/watchman/4.9.0/20180624025538 to /bin/watchman
» Binlinking watchman-make from jarvus/watchman/4.9.0/20180624025538 into /bin
★ Binlinked watchman-make from jarvus/watchman/4.9.0/20180624025538 to /bin/watchman-make
» Binlinking watchman-wait from jarvus/watchman/4.9.0/20180624025538 into /bin
★ Binlinked watchman-wait from jarvus/watchman/4.9.0/20180624025538 to /bin/watchman-wait
$ mkdir -m 777 -p /hab/svc/watchman/var
```

or with [homebrew](https://brew.sh/) (best option in Mac environments):

```console
$ brew install watchman
==> Downloading https://homebrew.bintray.com/bottles/watchman-4.9.0_2.mojave.bottle.tar.gz
Already downloaded: /Users/chris/Library/Caches/Homebrew/downloads/01bca112fb1c6fe86d4068af4635ca8a47a53688bb3597c4ac5e45e49fe1de27--watchman-4.9.0_2.mojave.bottle.tar.gz
==> Pouring watchman-4.9.0_2.mojave.bottle.tar.gz
==> launchctl unload -F /Users/chris/Library/LaunchAgents/com.github.facebook.watchman.plist
🍺  /usr/local/Cellar/watchman/4.9.0_2: 23 files, 2.1MB
```
