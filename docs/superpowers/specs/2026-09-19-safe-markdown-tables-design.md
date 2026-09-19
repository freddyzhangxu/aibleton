# Safe Markdown Table Rendering

## Goal

Render GitHub-flavored Markdown tables in assistant replies. A response such as
the user’s shortcut mapping should appear as aligned header and data cells,
instead of literal pipe characters and separator dashes.

## Scope

This extends the existing dependency-free, allowlisted Markdown renderer in
`ui/interface.html`. It applies to assistant replies only and uses the same
safe DOM-construction boundary as every other supported Markdown block.

## Recognition and rendering

A table begins only when two adjacent lines meet all of these conditions:

1. The first line has at least two pipe-delimited cells.
2. The next line has the same number of cells.
3. Every separator cell is a valid Markdown table divider: one or more dashes,
   optionally bounded by a colon for alignment.

The parser accepts optional leading and trailing pipe characters. It splits
cells on unescaped pipes and trims their outer whitespace. The header becomes
`thead > tr > th`; following compatible rows become `tbody > tr > td`.
Existing inline Markdown parsing is run independently for each cell, so bold,
inline code, and safe links keep working.

Column-alignment markers are recognized and applied through each cell’s
`text-align` style: a leading colon means left alignment, a trailing colon
means right alignment, and both mean center alignment.

## Safety and malformed input

The renderer creates `table`, `thead`, `tbody`, `tr`, `th`, and `td` elements
with `document.createElement`, and inserts cell content through the existing
text-node/allowlisted-inline parser. Model output is never assigned to
`innerHTML`.

If a potential table lacks a valid divider or any data row has a different
number of cells, it is handled as normal Markdown paragraph text. This prevents
ordinary prose containing pipes from being silently rearranged or dropped.

## Presentation

Tables receive scoped AI-message styles: compact borders, a muted header,
cell padding, and the existing dark UI palette. Each table sits in an overflow
wrapper so a wide table scrolls horizontally inside its chat bubble without
forcing the whole dialog wider.

## Verification

Manually verify the supplied shortcut table: header, four rows, bold shortcut
cells, and alignment should render correctly. Also verify no-leading-pipe
tables, alignment markers, safe inline markup in cells, a wide table’s local
scrolling, and malformed/mismatched tables falling back to ordinary text. Run
the production build after implementation.
