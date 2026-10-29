# Third-party notices

This repository contains a small set of third-party assets so that the pet can
run out of the box. They are **not** covered by the MIT license in `LICENSE`.

## Default VRM model

- File: `public/sample.vrm`
- Title: `AvatarSample_A`
- Author: VRoid Project
- License: VRoid sample-model license (`Other` in the VRM metadata)
- License URL: https://hub.vroid.com/license?allowed_to_use_user=everyone&characterization_allowed_user=everyone&corporate_commercial_use=allow&credit=unnecessary&modification=allow&personal_commercial_use=profit&redistribution=allow&sexual_expression=allow&version=1&violent_expression=allow
- The embedded VRM metadata allows redistribution. Credit is not required by
  the license, but the author is credited here.

## Default animations

- Files:
  - `animations/idle-maid.vrma`
  - `animations/idle-sitting.vrma`
  - `animations/grabbed.vrma`
- Author: not-elm / Desktop Homunculus
- Package: `@hmcs/assets`
- License: CC-BY-4.0 (the package is MIT AND CC-BY-4.0)
- Source: https://github.com/not-elm/desktop-homunculus
- License: https://creativecommons.org/licenses/by/4.0/
- Changes: the files are used as VRMA animation assets by this app.

Attribution: *Default idle and grabbed animations by not-elm / Desktop
Homunculus, licensed under CC-BY-4.0.*

## Code dependencies

The source code depends on open-source packages including:

- Tauri (MIT OR Apache-2.0)
- Three.js (MIT)
- `@pixiv/three-vrm` and `@pixiv/three-vrm-animation` (MIT)
- Microsoft Edge TTS / `edge-tts` (used as an external voice service)

Their licenses remain in effect. See `package.json`, `package-lock.json` and
`src-tauri/Cargo.toml` for the exact dependency versions.

## Not included

The following are intentionally **not** part of this repository:

- personal `.vrm` models
- personal or downloaded `.vrma` actions (the 42-action local collection)
- `.mp3` music and downloaded song caches
- conversation memory (`memory/memory.json`)
- any API keys, tokens, `service.json`, `auth.json`, `.env` or certificates

The online song feature searches a third-party music service at runtime. It is
not affiliated with this project; users are responsible for how they use it.
