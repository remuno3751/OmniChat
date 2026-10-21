# Webview fonts

Self-hosted WOFF2 files used by the webview themes, normal style. They cover every weight the app registers (app/src/fonts.ts): Space Grotesk 400/500/700, Syncopate 400/700, Zen Maru Gothic 400/700, Outfit 400/600, Marcellus 400. `src/ui/html.ts` (`FONT_FACES`) declares each file with its real weight.
Files were taken from the `@fontsource/*` npm packages (not added as project dependencies).

| File | Font | Subset | Source package | Version | License |
|------|------|--------|----------------|---------|---------|
| `SpaceGrotesk-Regular.woff2` | Space Grotesk | latin | `@fontsource/space-grotesk` | 5.3.0 | OFL-1.1 (`licenses/SpaceGrotesk-OFL.txt`) |
| `Syncopate-Regular.woff2` (Frontier) | Syncopate | latin | `@fontsource/syncopate` | 5.3.0 | Apache-2.0 (`licenses/Syncopate-Apache-2.0.txt`) |
| `ZenMaruGothic-Regular.woff2` | Zen Maru Gothic | japanese | `@fontsource/zen-maru-gothic` | 5.3.1 | OFL-1.1 (`licenses/ZenMaruGothic-OFL.txt`) |
| `Outfit-Regular.woff2` | Outfit | latin | `@fontsource/outfit` | 5.3.0 | OFL-1.1 (`licenses/Outfit-OFL.txt`) |
| `Marcellus-Regular.woff2` (Astral) | Marcellus | latin | `@fontsource/marcellus` | 5.3.0 | OFL-1.1 (`licenses/Marcellus-OFL.txt`) |

Weights added in 0.2.4 (same packages and licenses as above, file names show the weight):

| File | Font | Subset | Weight |
|------|------|--------|--------|
| `SpaceGrotesk-Medium.woff2`, `SpaceGrotesk-Bold.woff2` | Space Grotesk | latin | 500, 700 |
| `Syncopate-Bold.woff2` | Syncopate | latin | 700 |
| `Outfit-SemiBold.woff2` | Outfit | latin | 600 |
| `ZenMaruGothic-Bold.woff2` | Zen Maru Gothic | japanese | 700 |
| `ZenMaruGothic-Latin-Regular.woff2`, `ZenMaruGothic-Latin-Bold.woff2` | Zen Maru Gothic | latin | 400, 700 (declared after the Japanese files with a Latin `unicode-range`) |

Notes:

- Syncopate is licensed under Apache-2.0, not OFL-1.1, according to its package LICENSE and metadata. The license text is included as `licenses/Syncopate-Apache-2.0.txt`.
- Zen Maru Gothic uses the `japanese` subset because it is the full-coverage file available for weight 400 (about 1.4 MB). Its `latin` subset is smaller but covers only Latin characters. Nothing was skipped.
- Total size of the WOFF2 files in this directory is about 3.1 MB.
- Copyright holders are listed in the license files and in `THIRD_PARTY_NOTICES.txt` at the repository root.
