# Third-party components

HTML Viewer source is MIT licensed. Bundled dependencies retain their original
licenses; the app license does not replace them.

| Component | License | Included notice |
| --- | --- | --- |
| Monaco Editor 0.57.0 | MIT | `assets/vendor/monaco-editor/0.57.0/LICENSE.txt` |
| Lucide 1.21.0 and Feather-derived icons | ISC / MIT | `assets/licenses/Lucide.txt` |
| JSZip 3.10.2 | MIT option of MIT / GPLv3 | `assets/licenses/JSZip.txt` |
| Pako, bundled with JSZip | MIT / zlib | `assets/licenses/Pako.txt`, `assets/licenses/Pako-zlib.txt` |
| Inter | SIL Open Font License 1.1 | `assets/fonts/OFL-Inter.txt` |
| Outfit | SIL Open Font License 1.1 | `assets/fonts/OFL-Outfit.txt` |
| JetBrains Mono | SIL Open Font License 1.1 | `assets/fonts/OFL-JetBrains-Mono.txt` |

Lucide is reduced to the icons used by the interface. Monaco's upstream ESM
sources and workers are bundled locally with esbuild. JSZip's browser wrapper
keeps it independent of module loaders. Original icon/ZIP builds are in `vendor/`.
