# OmniChat logo proposals

Fifteen original concepts, five per theme. Each has a 256x256 symbol mark (`<theme>-<n>.svg`) and a horizontal lockup with an `OmniChat` SVG `<text>` wordmark (`<theme>-<n>-lockup.svg`, height 256, width 800-880). Marks are transparent (Simple) or self-contained badges (Frontier, Astral), so one file works on light and dark backgrounds; no separate `-dark`/`-light` files are needed. Lettering uses font stacks (Inter/Segoe UI, Bahnschrift, Georgia); it is not outlined, so convert to paths for the chosen logo before shipping.

Compare everything in `index.html` (self-contained; open directly or serve this folder).

## Simple (greens `#10a37f`, `#19c37d`, neutrals)
- simple-1 Orbit O: bold ring with orbiting device dots and a chat tail.
- simple-2 Bubble + nodes: speech bubble holding a three-node network.
- simple-3 Overlapping bubbles: filled and outlined bubbles, two voices across devices.
- simple-4 Infinity chat: lemniscate, O lobe plus bubble lobe with tail.
- simple-5 App tile: green rounded tile, white O-bubble with typing dots.

## Frontier (`#fffa00`, `#c8af23`, `#141414`, white; industrial/tactical)
- frontier-1 Bracket bubble: four corner brackets, chamfered tail, diamond core.
- frontier-2 Hex node network: hexagon, three device nodes linked to a core.
- frontier-3 Angular O + tail: octagonal ring, slash accent, typing squares.
- frontier-4 Radar scan: concentric octagons, N/E/S/W ticks, pointer.
- frontier-5 Omega terminal: angular Omega with prompt chevron and cursor.

## Astral (`#f9c837`, `#f4a747`, cream `#fbe9b6`, deep `#2a2827`, lavender `#c9a6ff`)
- astral-1 Star in bubble: four-point star inside a cream speech bubble.
- astral-2 Orbit rings: crossing orbits around a star with device dots.
- astral-3 Star ticket: notched ticket, perforation, star and chat dots.
- astral-4 Navigator notebook: constellation notebook with a guiding star.
- astral-5 Star-rail O: railway-track ring around a star.

## How the chosen logo will be applied
- App header / splash: the lockup (or mark alone on narrow layouts) inlined in the UI header; the mark enlarged on the splash.
- Favicon: the mark as `favicon.svg` plus 32/16 px PNG fallbacks (check legibility at 16 px in `index.html` first).
- Desktop and server app icons: export the mark to a 1024x1024 PNG and run `tauri icon` to generate all platform icons (ico/icns/png).
- Installer: icon from the same set; lockup on the installer banner/header image.
- README banner: lockup rendered on a light or dark banner image at the top of the repository README.
