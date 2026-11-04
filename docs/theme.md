# Palette matched to the supplied PDF

The original light/mint implementation has been replaced by the dark maritime palette sampled from the user's Figma-exported PDF. `apps/web/app/theme.css` contains shared color roles; layout and form/booking behaviors remain responsive. The home search/route cards and auth text inputs are deliberately white, as in the reference.

| Role | PDF color |
| --- | --- |
| Page gradient | `#071426` → `#2563BA` |
| Header and outer cards | `#17253A` |
| Travel advisory | `#063E37` |
| Footer | `#08345B` |
| Home popular-route section | `#0B1F3A` |
| Auth form | `#103653` |
| Sailing panels | `#101D31` |
| Inner panels and inputs | `#0B182A` / `#08172A` |
| Blue actions and selected seats | `#0B4F8A` |
| Booking/refund actions | `#11C89C` |
| Cyan accents | `#20B9E8` |
| Main text / muted text | `#F2F7FC` / `#A0B0C8` |

Reference pages inspected: home (1/3), search results (2), sign-in (4), registration (5), seats (8), payment (10), boarding modal (14), refund (15). Active-navigation text uses a lighter cyan to maintain readable contrast. Print surfaces remain white with dark text and blue fare/seat accents. Staff screens share the same palette.

Validation: frontend production build; desktop home/auth screenshots and computed reference-color checks; all ten existing Chromium account/search/payment/ticket/refund/staff flows. This is a palette correction; it does not claim a pixel-for-pixel recreation of every PDF layout or image.
