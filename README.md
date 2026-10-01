# QQ / NetEase / Qishui (qqovo) - EchoMusic Plugin

Repo: https://github.com/nlxxtw/Musicplugin

## Online install / update

1. EchoMusic -> Plugin Manager -> Plugin Sources -> add: github:nlxxtw/Musicplugin
2. Install QQ/NetEase/Qishui (qqovo); host checks updates via manifest version
3. China mirror: install GitHub Accelerator plugin, set mirror to https://github.19492035.xyz

Online update uses echo-plugins.json (NOT Actions). Actions only packages Release zip.

Manual accelerated zip:
https://github.19492035.xyz/https://github.com/nlxxtw/Musicplugin/archive/refs/heads/main.zip

## Release (maintainer)

1. Bump manifest.json version
2. git tag vX.Y.Z && git push origin main --tags

## Notes

Requires unrestrictedNetwork, audioSource, lyrics. For learning only.
