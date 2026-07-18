# Dashboard Override — djmima Vault

This file intentionally overrides the mobile/dark recommendation in `../MASTER.md` for the first desktop web password-vault screen.

## Direction

- Product surface: signed-in desktop web vault, not a marketing landing page.
- Style: restrained security utility; light, high-contrast, dense but calm.
- Layout: fixed desktop navigation, a four-card risk summary strip with equal hierarchy, credential table/list, and contextual detail panel. Collapse to an off-canvas menu and single column on smaller screens.
- Information architecture: explain public visibility inline when it is selected or confirmed; do not use a catch-all public-permissions dialog. Put export approvals in Personal Info → Data & Security, and put administrator-only public/system/export audit events in a User Management tab.
- Primary: deep blue-gray `#293D43`; accent and positive state: restrained teal `#467C79`; canvas: soft neutral mist `#F7F9FA`; surfaces: white. Keep risk amber/red semantic rather than recoloring it teal.
- Typography: Geist with Chinese system-font fallbacks. Use compact hierarchy and tabular numerals for scores and dates.
- Radius: 7–14px with a controlled scale. Prefer separators and tonal surfaces over card shadows.
- Motion: 180–220ms state transitions only; no ambient blobs, parallax, glow, spring choreography, or decorative reveal.

## Password-manager anti-patterns

- No excessive decoration.
- Never communicate security status with color alone; pair every status with icon and text.
- No purple/pink gradients, glass effects, neon glow, generic bento tiles, or stock security imagery.
- Never imply production-grade encryption or persistence in this front-end demo.
- Do not write sample or user-entered credentials to browser storage.

## Delivery checks

- Desktop controls use a compact 36px target; retain 44px touch targets for the primary mobile action. Keep focus visible and keyboard order usable.
- Normal text contrast at least 4.5:1; status UI at least 3:1 and supported by text/icon.
- Responsive checks at 375, 768, 1024, and 1440px; no horizontal page scroll.
- Meaningful loading/copy/add/lock feedback and an aria-live status region. Preserve layout with compact skeletons while vault data, item detail, user tables, and profile security data are loading.
- `prefers-reduced-motion` disables nonessential transitions.
