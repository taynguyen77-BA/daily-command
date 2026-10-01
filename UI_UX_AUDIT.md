# UI/UX Audit — Command Center (V2.32)

This was a visual and interaction pass over the whole app. No feature, page, button,
data-attribute or aria attribute was removed, and every label the test suite checks is
unchanged. `npm test` still passes all 2616 checks, and `tsc`, `next lint` and
`next build` are clean.

## Findings (before)

| # | Area | Problem |
|---|---|---|
| 1 | Layout grid | Header and nav were full-bleed and left-aligned, while page content was centred at `max-w-6xl`. The three left edges did not line up. |
| 2 | Navigation | At 1440px the 12 links wrapped onto 2 rows. Group labels were 10px caps, with a separator after every group (including the last). The nav scrolled away with the page. |
| 3 | Contrast | `text3` (#6b7484 on #12161f) was about 3.6:1. It failed WCAG AA for the small text it was used on everywhere. |
| 4 | Hierarchy | Page titles were the same 18px as section headings, so pages had no clear top. |
| 5 | Buttons | About 140 hand-written class strings, each with slightly different sizes, padding and hover colours. There was no clear primary / secondary / quiet distinction. |
| 6 | Badges | Six different sizes (10–12px, `rounded` vs `rounded-md`, `py-0` vs `py-0.5`) sat next to each other in the same rows. |
| 7 | Ticket row (mobile) | The action cluster was `shrink-0`, so at 375px "Defer…" ran off the card edge. |
| 8 | Ticket row (cards) | Inside half-width cards the buttons were squeezed beside the ticket text. |
| 9 | Attention card | The ticket key appeared twice (header + ticket row). Seven badges sat in the header. Seven equal-weight buttons wrapped awkwardly ("Resolve" alone on a line). |
| 10 | Horizontal overflow | `/` (445px), `/memory` (436px) and `/priorities` (391px) scrolled sideways at 375px. |
| 11 | Keyboard | There was no visible focus indicator. |
| 12 | View switchers | My Work, Priorities, Action Plan and Command Center each had a different tab style. |

## Changes

**Design tokens** (`tailwind.config.ts`):
- `text2` and `text3` were raised to 8:1 and 5:1.
- Added `surface3`, `border2`, a single `max-w-shell` container, and `card` / `pop` shadows.

**Component classes** (`globals.css`), one definition each:
- Buttons: `.btn` with `-primary`, `-secondary`, `-ghost`, `-success`, `-danger` and a `-sm` size.
- Segmented tabs: `.seg`, `.seg-item`, `.seg-item-active` and `.count-pill`.
- Text helpers: `.eyebrow`, `.link` and `.tabular` (aligned numbers).
- Base styles: a global `:focus-visible` ring, and the text-selection and scrollbar colours.

**Shell** (header, nav, page content):
- All three share `max-w-shell`.
- The header is compact: a logo mark, title, then date · greeting, with a status dot on the data-source pill.
- The nav is sticky with a translucent background and fits one row at desktop sizes. Group names show in the mobile menu and on very wide screens; dividers carry the grouping elsewhere. The active link has `aria-current`.

**Typography:**
- `SectionHeading` gained `level="page"` (24px, semibold), applied to every page title.
- Section headings are 18px semibold.

**Badges:**
- One scale everywhere: 11px semibold, `rounded-md`, with 10px uppercase only for meta/status pills.
- Long pills wrap instead of overflowing.

**Ticket row (`TaskRow`):**
- Stacks on mobile and sits beside the text on wide rows.
- A `stacked` layout prop is used inside cards (focus cards, Priorities, Attention, the My Work summary, Action Plan).
- "Done" is styled as the positive action, and "Open in Jira" is a quiet ghost link.

**Attention card:**
- The duplicate ticket key is gone (it lives in the ticket row).
- The lifecycle badge is right-aligned and the title is stronger.
- "Now what" is highlighted.
- Actions are grouped: primary moves on the left, acknowledge / snooze / resolve as quiet buttons on the right.

**Other screens:**
- **Segmented tabs everywhere:** My Work (with count pills), Priorities, Action Plan budgets and Command Center Operations/Executive.
- **My Work header:** the "Calculated" trust label and the "My action items only" toggle are grouped. The keyboard hint shows on desktop only.
- **Command Center:** My Work's counts became a 3×2 grid of stat tiles.
- **Action Plan:** a time-budget progress bar, plus "Ticket" and "This planned action" labels separating the two button clusters.
- **Overflow:** `/`, `/memory` and `/priorities` now fit at 375px. Panels can shrink inside grids, and card header rows wrap.

## Verification

- 1440px and 375px screenshots were checked for My Work, Command Center, Priorities, Action Plan, Attention and the Focus Session modal.
- An automated check found no horizontal overflow at 375px on any route.
- Tab focus shows the ring.
- A ticket action round-trip still works and was restored afterwards.
