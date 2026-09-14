# Direct download links

## Goal

Let visitors download the current AIbleton release assets with one click from both the repository homepage and the top download section of release `v0.9.10`.

## Scope

- Replace the homepage download table's plain asset filenames with direct GitHub Release asset URLs.
- Replace the `v0.9.10` Release notes download table's plain asset filenames with the same direct URLs.
- Retain links to the full Releases page for historical versions.

## Link format

Each link uses GitHub's immutable release-asset pattern:

`https://github.com/freddyzhangxu/aibleton/releases/download/v0.9.10/<asset-name>`

Assets:

- `AIbleton-0.9.10.ablx`
- `AIbletonBar-0.9.10-macOS.zip`
- `AIbletonBar-0.9.10-Windows.zip`

## Behaviour and maintenance

Clicking an asset name begins GitHub's download flow without visiting the Releases list or expanding the asset list. The release notes and README use the same URLs. For a future release, its asset names and tag must be updated in the new Release notes and the homepage tables.

## Verification

- Confirm every rendered filename uses the expected direct asset URL.
- Confirm all three URLs return a download response.
- Confirm the Releases page link remains available.
